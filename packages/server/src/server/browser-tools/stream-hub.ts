import type { BrowserToolsBroker } from "./broker.js";

interface BrowserStreamLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface BrowserStreamStartResult {
  ok: boolean;
  width?: number;
  height?: number;
  error?: { code: string; message: string };
}

export interface BrowserStreamStarter {
  start(input: {
    browserId: string;
    workspaceId?: string;
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
    minFrameIntervalMs?: number;
  }): Promise<BrowserStreamStartResult>;
  stop(input: { browserId: string; workspaceId?: string }): Promise<void>;
}

interface BrowserStreamWatcher {
  connectionKey: string;
  send(bytes: Uint8Array): boolean | void;
  pendingFrame: Uint8Array | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

interface BrowserStreamEntry {
  workspaceId?: string;
  watchers: Map<string, BrowserStreamWatcher>;
  starting: Promise<BrowserStreamStartResult> | null;
  started: BrowserStreamStartResult | null;
  stopping: Promise<void> | null;
}

interface BrowserStreamWatchInput {
  browserId: string;
  workspaceId?: string;
  watcherKey: string;
  connectionKey?: string;
  send: (bytes: Uint8Array) => boolean | void;
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  minFrameIntervalMs?: number;
}

const WATCHER_RETRY_INTERVAL_MS = 100;
const BROWSER_CLOSED_DURING_START: BrowserStreamStartResult = {
  ok: false,
  error: { code: "browser_tab_closed", message: "Browser tab closed while starting stream." },
};

/**
 * Fans live browser stream frames from the desktop browser host out to
 * subscribed client connections, and owns the host-side screencast lifecycle:
 * the first watcher starts the stream, the last watcher stops it.
 */
export class BrowserStreamHub {
  private readonly entries = new Map<string, BrowserStreamEntry>();

  public constructor(
    private readonly starter: BrowserStreamStarter,
    private readonly logger?: BrowserStreamLogger,
  ) {}

  public async watch(input: BrowserStreamWatchInput): Promise<BrowserStreamStartResult> {
    const resolved = this.resolveWatchEntry(input);
    if ("failure" in resolved) {
      return resolved.failure;
    }
    const { entry } = resolved;
    this.replaceWatcher(entry, input);

    if (entry.stopping) {
      await entry.stopping;
    }
    if (this.entries.get(input.browserId) !== entry) {
      return BROWSER_CLOSED_DURING_START;
    }
    if (entry.started?.ok) {
      return entry.started;
    }

    const starting = this.ensureStarting(entry, input);
    const result = await starting;
    this.recordStartResult(input.browserId, entry, starting, result);
    if (entry.watchers.size === 0) {
      await this.stopIfIdle(input.browserId, entry);
    }
    return result;
  }

  private resolveWatchEntry(
    input: BrowserStreamWatchInput,
  ): { entry: BrowserStreamEntry } | { failure: BrowserStreamStartResult } {
    const entry = this.entries.get(input.browserId) ?? {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      watchers: new Map<string, BrowserStreamWatcher>(),
      starting: null,
      started: null,
      stopping: null,
    };
    if (entry.workspaceId && input.workspaceId && entry.workspaceId !== input.workspaceId) {
      return {
        failure: {
          ok: false,
          error: {
            code: "browser_denied",
            message: "Browser tab does not belong to this workspace.",
          },
        },
      };
    }
    if (!entry.workspaceId && input.workspaceId) {
      entry.workspaceId = input.workspaceId;
    }
    this.entries.set(input.browserId, entry);
    return { entry };
  }

  private replaceWatcher(entry: BrowserStreamEntry, input: BrowserStreamWatchInput): void {
    const previousWatcher = entry.watchers.get(input.watcherKey);
    if (previousWatcher) {
      this.clearWatcher(previousWatcher);
    }
    entry.watchers.set(input.watcherKey, {
      connectionKey: input.connectionKey ?? input.watcherKey,
      send: input.send,
      pendingFrame: null,
      retryTimer: null,
    });
  }

  private ensureStarting(
    entry: BrowserStreamEntry,
    input: BrowserStreamWatchInput,
  ): Promise<BrowserStreamStartResult> {
    if (!entry.starting) {
      entry.starting = this.starter
        .start({
          browserId: input.browserId,
          ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
          ...(input.maxWidth !== undefined ? { maxWidth: input.maxWidth } : {}),
          ...(input.maxHeight !== undefined ? { maxHeight: input.maxHeight } : {}),
          ...(input.quality !== undefined ? { quality: input.quality } : {}),
          ...(input.minFrameIntervalMs !== undefined
            ? { minFrameIntervalMs: input.minFrameIntervalMs }
            : {}),
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: { code: "browser_unknown_error", message } };
        });
    }
    return entry.starting;
  }

  private recordStartResult(
    browserId: string,
    entry: BrowserStreamEntry,
    starting: Promise<BrowserStreamStartResult>,
    result: BrowserStreamStartResult,
  ): void {
    if (this.entries.get(browserId) !== entry || entry.starting !== starting) {
      return;
    }
    entry.starting = null;
    entry.started = result.ok ? result : null;
  }

  public async unwatch(browserId: string, watcherKey: string): Promise<void> {
    const entry = this.entries.get(browserId);
    const watcher = entry?.watchers.get(watcherKey);
    if (!entry || !watcher) {
      return;
    }
    this.clearWatcher(watcher);
    entry.watchers.delete(watcherKey);
    await this.stopIfIdle(browserId, entry);
  }

  public async removeConnection(connectionKey: string): Promise<void> {
    for (const [browserId, entry] of this.entries) {
      let removed = false;
      for (const [watcherKey, watcher] of entry.watchers) {
        if (watcher.connectionKey !== connectionKey) {
          continue;
        }
        this.clearWatcher(watcher);
        entry.watchers.delete(watcherKey);
        removed = true;
      }
      if (removed) {
        await this.stopIfIdle(browserId, entry);
      }
    }
  }

  /** Host tab closed or host disconnected: drop state without issuing stream_stop. */
  public dropBrowser(browserId: string): void {
    const entry = this.entries.get(browserId);
    if (!entry) {
      return;
    }
    for (const watcher of entry.watchers.values()) {
      this.clearWatcher(watcher);
    }
    this.entries.delete(browserId);
  }

  public routeFrame(browserId: string, bytes: Uint8Array): void {
    const entry = this.entries.get(browserId);
    if (!entry) {
      return;
    }
    for (const [watcherKey, watcher] of entry.watchers) {
      if (this.sendToWatcher(watcher, bytes)) {
        watcher.pendingFrame = null;
        continue;
      }
      // Preserve only the newest frame. A static compositor update may be the
      // final frame, so retrying it avoids leaving a recovered socket stale.
      watcher.pendingFrame = bytes;
      this.scheduleWatcherRetry(browserId, entry, watcherKey, watcher);
    }
  }

  public getWatcherCount(browserId: string): number {
    return this.entries.get(browserId)?.watchers.size ?? 0;
  }

  public static readonly MAX_WATCHER_BUFFERED_BYTES = 2 * 1024 * 1024;

  private sendToWatcher(watcher: BrowserStreamWatcher, bytes: Uint8Array): boolean {
    try {
      return watcher.send(bytes) !== false;
    } catch {
      return false;
    }
  }

  private scheduleWatcherRetry(
    browserId: string,
    entry: BrowserStreamEntry,
    watcherKey: string,
    watcher: BrowserStreamWatcher,
  ): void {
    if (watcher.retryTimer) {
      return;
    }
    watcher.retryTimer = setTimeout(() => {
      watcher.retryTimer = null;
      if (this.entries.get(browserId) !== entry || entry.watchers.get(watcherKey) !== watcher) {
        return;
      }
      const pending = watcher.pendingFrame;
      if (!pending) {
        return;
      }
      if (this.sendToWatcher(watcher, pending)) {
        watcher.pendingFrame = null;
        return;
      }
      this.scheduleWatcherRetry(browserId, entry, watcherKey, watcher);
    }, WATCHER_RETRY_INTERVAL_MS);
  }

  private clearWatcher(watcher: BrowserStreamWatcher): void {
    if (watcher.retryTimer) {
      clearTimeout(watcher.retryTimer);
      watcher.retryTimer = null;
    }
    watcher.pendingFrame = null;
  }

  private async stopIfIdle(browserId: string, entry: BrowserStreamEntry): Promise<void> {
    if (entry.watchers.size > 0 || this.entries.get(browserId) !== entry) {
      return;
    }
    if (entry.starting) {
      await entry.starting;
      if (entry.watchers.size > 0 || this.entries.get(browserId) !== entry) {
        return;
      }
    }
    if (entry.stopping) {
      await entry.stopping;
      if (entry.watchers.size > 0 || this.entries.get(browserId) !== entry) {
        return;
      }
    }
    if (entry.started?.ok) {
      entry.started = null;
      const stopping = this.starter
        .stop({
          browserId,
          ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
        })
        .catch((error: unknown) => {
          this.logger?.warn(
            { browserId, error: error instanceof Error ? error.message : String(error) },
            "Failed to stop browser stream",
          );
        });
      entry.stopping = stopping;
      await stopping;
      if (entry.stopping === stopping) {
        entry.stopping = null;
      }
    }
    if (
      entry.watchers.size === 0 &&
      entry.starting === null &&
      entry.stopping === null &&
      this.entries.get(browserId) === entry
    ) {
      this.entries.delete(browserId);
    }
  }
}

export function createBrokerStreamStarter(
  broker: Pick<BrowserToolsBroker, "execute">,
): BrowserStreamStarter {
  return {
    async start(input) {
      const payload = await broker.execute({
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        command: {
          command: "stream_start",
          args: {
            browserId: input.browserId,
            ...(input.maxWidth !== undefined ? { maxWidth: input.maxWidth } : {}),
            ...(input.maxHeight !== undefined ? { maxHeight: input.maxHeight } : {}),
            ...(input.quality !== undefined ? { quality: input.quality } : {}),
            ...(input.minFrameIntervalMs !== undefined
              ? { minFrameIntervalMs: input.minFrameIntervalMs }
              : {}),
          },
        },
      });
      if (payload.ok && payload.result.command === "stream_start") {
        return { ok: true, width: payload.result.width, height: payload.result.height };
      }
      if (payload.ok) {
        return {
          ok: false,
          error: { code: "browser_unknown_error", message: "Unexpected stream_start result" },
        };
      }
      return { ok: false, error: { code: payload.error.code, message: payload.error.message } };
    },
    async stop(input) {
      await broker.execute({
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        command: { command: "stream_stop", args: { browserId: input.browserId } },
      });
    },
  };
}
