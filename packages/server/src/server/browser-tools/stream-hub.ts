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
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
  }): Promise<BrowserStreamStartResult>;
  stop(browserId: string): Promise<void>;
}

interface BrowserStreamWatcher {
  send(bytes: Uint8Array): void;
}

interface BrowserStreamEntry {
  watchers: Map<string, BrowserStreamWatcher>;
  starting: Promise<BrowserStreamStartResult> | null;
  started: BrowserStreamStartResult | null;
}

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

  public async watch(input: {
    browserId: string;
    watcherKey: string;
    send: (bytes: Uint8Array) => void;
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
  }): Promise<BrowserStreamStartResult> {
    const entry = this.entries.get(input.browserId) ?? {
      watchers: new Map<string, BrowserStreamWatcher>(),
      starting: null,
      started: null,
    };
    this.entries.set(input.browserId, entry);
    entry.watchers.set(input.watcherKey, { send: input.send });

    if (entry.started?.ok) {
      return entry.started;
    }
    if (!entry.starting) {
      entry.starting = this.starter
        .start({
          browserId: input.browserId,
          ...(input.maxWidth !== undefined ? { maxWidth: input.maxWidth } : {}),
          ...(input.maxHeight !== undefined ? { maxHeight: input.maxHeight } : {}),
          ...(input.quality !== undefined ? { quality: input.quality } : {}),
        })
        .then((result) => {
          entry.starting = null;
          entry.started = result.ok ? result : null;
          return result;
        })
        .catch((error: unknown) => {
          entry.starting = null;
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: { code: "browser_unknown_error", message } };
        });
    }
    const result = await entry.starting;
    if (!result.ok && entry.watchers.size === 0) {
      this.entries.delete(input.browserId);
    }
    return result;
  }

  public async unwatch(browserId: string, watcherKey: string): Promise<void> {
    const entry = this.entries.get(browserId);
    if (!entry || !entry.watchers.delete(watcherKey)) {
      return;
    }
    await this.stopIfIdle(browserId, entry);
  }

  public async removeConnection(watcherKey: string): Promise<void> {
    for (const [browserId, entry] of this.entries) {
      if (entry.watchers.delete(watcherKey)) {
        await this.stopIfIdle(browserId, entry);
      }
    }
  }

  /** Host tab closed or host disconnected: drop state without issuing stream_stop. */
  public dropBrowser(browserId: string): void {
    this.entries.delete(browserId);
  }

  public routeFrame(browserId: string, bytes: Uint8Array): void {
    const entry = this.entries.get(browserId);
    if (!entry) {
      return;
    }
    for (const watcher of entry.watchers.values()) {
      watcher.send(bytes);
    }
  }

  public getWatcherCount(browserId: string): number {
    return this.entries.get(browserId)?.watchers.size ?? 0;
  }

  public static readonly MAX_WATCHER_BUFFERED_BYTES = 2 * 1024 * 1024;

  private async stopIfIdle(browserId: string, entry: BrowserStreamEntry): Promise<void> {
    if (entry.watchers.size > 0) {
      return;
    }
    const wasStarted = entry.started?.ok === true || entry.starting !== null;
    this.entries.delete(browserId);
    if (!wasStarted) {
      return;
    }
    try {
      await this.starter.stop(browserId);
    } catch (error) {
      this.logger?.warn(
        { browserId, error: error instanceof Error ? error.message : String(error) },
        "Failed to stop browser stream",
      );
    }
  }
}

export function createBrokerStreamStarter(
  broker: Pick<BrowserToolsBroker, "execute">,
): BrowserStreamStarter {
  return {
    async start(input) {
      const payload = await broker.execute({
        command: {
          command: "stream_start",
          args: {
            browserId: input.browserId,
            ...(input.maxWidth !== undefined ? { maxWidth: input.maxWidth } : {}),
            ...(input.maxHeight !== undefined ? { maxHeight: input.maxHeight } : {}),
            ...(input.quality !== undefined ? { quality: input.quality } : {}),
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
    async stop(browserId) {
      await broker.execute({ command: { command: "stream_stop", args: { browserId } } });
    },
  };
}
