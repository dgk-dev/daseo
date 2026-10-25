import { randomUUID } from "node:crypto";
import {
  ClientDebugCollectResponseSchema,
  type ClientDebugCollectPayload,
  type ClientDebugCollectRequest,
} from "@getpaseo/protocol/messages";

// Daseo delta 68: the daemon asks one connected app for its own logs (JS console ring, and on
// Android its own logcat and exit traces), so the phone can be read without wireless ADB. Apps
// that advertise `debug_collect` register here while they have a live socket.

export interface ClientDebugTarget {
  clientId: string;
  platform: string;
  appVersion: string | null;
  send: (request: ClientDebugCollectRequest) => void;
}

export interface ClientDebugTargetInfo {
  clientId: string;
  platform: string;
  appVersion: string | null;
  connectedAt: number;
}

export type ClientDebugCollectResult =
  | { ok: true; target: ClientDebugTargetInfo; payload: ClientDebugCollectPayload }
  | {
      ok: false;
      code: "no_client" | "unknown_client" | "timeout" | "disconnected";
      message: string;
    };

interface RegisteredTarget {
  target: ClientDebugTarget;
  connectedAt: number;
  sequence: number;
}

interface PendingCollect {
  clientId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: ClientDebugCollectResult) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ClientDebugBroker {
  private readonly targets = new Map<string, RegisteredTarget>();
  private readonly pending = new Map<string, PendingCollect>();
  private sequence = 0;

  public constructor(
    private readonly options: { now?: () => number; createRequestId?: () => string } = {},
  ) {}

  public register(target: ClientDebugTarget): () => void {
    const sequence = ++this.sequence;
    this.targets.set(target.clientId, {
      target,
      connectedAt: this.now(),
      sequence,
    });
    return () => this.unregister(target.clientId, sequence);
  }

  public unregister(clientId: string, sequence?: number): void {
    const current = this.targets.get(clientId);
    if (!current || (sequence !== undefined && current.sequence !== sequence)) {
      return;
    }
    this.targets.delete(clientId);
    for (const [requestId, pending] of this.pending) {
      if (pending.clientId !== clientId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve({
        ok: false,
        code: "disconnected",
        message: "The app disconnected before it sent its logs.",
      });
    }
  }

  /** Connected apps that can answer, phones first, most recently connected first. */
  public list(): ClientDebugTargetInfo[] {
    return Array.from(this.targets.values())
      .sort((left, right) => {
        const phone =
          Number(isPhone(right.target.platform)) - Number(isPhone(left.target.platform));
        return phone || right.sequence - left.sequence;
      })
      .map(({ target, connectedAt }) => ({
        clientId: target.clientId,
        platform: target.platform,
        appVersion: target.appVersion,
        connectedAt,
      }));
  }

  public async collect(input: {
    clientId?: string;
    maxConsoleEntries?: number;
    maxLogcatLines?: number;
    includeExitInfo?: boolean;
    timeoutMs?: number;
  }): Promise<ClientDebugCollectResult> {
    const targets = this.list();
    const info = input.clientId
      ? targets.find((target) => target.clientId === input.clientId)
      : targets[0];
    if (!info) {
      return input.clientId
        ? {
            ok: false,
            code: "unknown_client",
            message: `No connected app has id ${input.clientId}.`,
          }
        : {
            ok: false,
            code: "no_client",
            message:
              "No connected app can send logs. Open Daseo on the phone (version with delta 68) so it connects to this Mac.",
          };
    }
    const registered = this.targets.get(info.clientId);
    if (!registered) {
      return {
        ok: false,
        code: "unknown_client",
        message: `No connected app has id ${info.clientId}.`,
      };
    }
    const requestId = this.options.createRequestId?.() ?? `debug_${randomUUID()}`;
    const request: ClientDebugCollectRequest = {
      type: "client.debug.collect.request",
      requestId,
      ...(input.maxConsoleEntries !== undefined
        ? { maxConsoleEntries: input.maxConsoleEntries }
        : {}),
      ...(input.maxLogcatLines !== undefined ? { maxLogcatLines: input.maxLogcatLines } : {}),
      ...(input.includeExitInfo !== undefined ? { includeExitInfo: input.includeExitInfo } : {}),
    };
    return new Promise<ClientDebugCollectResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          ok: false,
          code: "timeout",
          message: "The app did not send its logs in time. It may be in the background or asleep.",
        });
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(requestId, {
        clientId: info.clientId,
        timeout,
        resolve: (result) => resolve(result),
      });
      try {
        registered.target.send(request);
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timeout);
        resolve({
          ok: false,
          code: "disconnected",
          message: error instanceof Error ? error.message : "Could not reach the app.",
        });
      }
    }).then((result) => (result.ok ? { ...result, target: info } : result));
  }

  /** Returns true when the message answered a pending request. */
  public receiveResponse(message: unknown): boolean {
    const parsed = ClientDebugCollectResponseSchema.safeParse(message);
    if (!parsed.success) {
      return false;
    }
    const pending = this.pending.get(parsed.data.payload.requestId);
    if (!pending) {
      return false;
    }
    this.pending.delete(parsed.data.payload.requestId);
    clearTimeout(pending.timeout);
    const registered = this.targets.get(pending.clientId);
    pending.resolve({
      ok: true,
      target: {
        clientId: pending.clientId,
        platform: registered?.target.platform ?? parsed.data.payload.platform,
        appVersion: registered?.target.appVersion ?? parsed.data.payload.appVersion ?? null,
        connectedAt: registered?.connectedAt ?? this.now(),
      },
      payload: parsed.data.payload,
    });
    return true;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function isPhone(platform: string): boolean {
  return platform === "android" || platform === "ios";
}

/** The `debug_collect` capability value, or null when the client did not advertise it. */
export function getClientDebugCapability(
  capabilities: Record<string, unknown> | null,
): { platform: string } | null {
  const value = capabilities?.debug_collect;
  if (typeof value !== "object" || value === null) return null;
  const platform = (value as { platform?: unknown }).platform;
  return typeof platform === "string" && platform.trim() ? { platform: platform.trim() } : null;
}
