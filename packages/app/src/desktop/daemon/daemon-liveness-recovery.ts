// Local fork (DASEO.md delta 126): when the desktop-managed daemon stops answering while the app
// runs, ask the desktop main process to wake or replace it.
//
// The daemon client already decides when a connection is dead: a ping every 10 s, a 15 s timeout,
// and a reconnect after two missed pings, so the host leaves "online" only after the daemon has been
// silent for about 25 s or its socket closed. The desktop side then acts only on a daemon whose
// process is alive but does not answer, sends it SIGCONT first, and replaces it only after another
// 12 s of silence; a busy daemon (worst measured event-loop stall 5 s) is never touched, and a
// stopped daemon (an activation or `paseo daemon restart`) is left alone.

import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

export const DAEMON_LIVENESS_RECOVERY_DELAY_MS = 5_000;
export const DAEMON_LIVENESS_RECOVERY_COOLDOWN_MS = 60_000;

export interface DaemonLivenessRecoveryDeps {
  getManagedServerId: () => string | null;
  subscribeManagedServerId: (listener: () => void) => () => void;
  getConnectionStatus: (serverId: string) => HostRuntimeConnectionStatus | null;
  subscribeConnectionStatus: (listener: () => void) => () => void;
  recover: () => Promise<unknown>;
  log?: (message: string, details?: Record<string, unknown>) => void;
  now?: () => number;
  delayMs?: number;
  cooldownMs?: number;
}

function isLostStatus(status: HostRuntimeConnectionStatus | null): boolean {
  // "idle" is a deliberate disconnect (background suspend), not a daemon that stopped answering.
  return status === "connecting" || status === "offline" || status === "error";
}

export function startDaemonLivenessRecovery(deps: DaemonLivenessRecoveryDeps): () => void {
  const now = deps.now ?? Date.now;
  const delayMs = deps.delayMs ?? DAEMON_LIVENESS_RECOVERY_DELAY_MS;
  const cooldownMs = deps.cooldownMs ?? DAEMON_LIVENESS_RECOVERY_COOLDOWN_MS;
  let stopped = false;
  let serverId: string | null = null;
  let wasOnline = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let recovering = false;
  let lastAttemptAt: number | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const currentStatus = (): HostRuntimeConnectionStatus | null =>
    serverId ? deps.getConnectionStatus(serverId) : null;

  const runRecovery = async () => {
    timer = null;
    const status = currentStatus();
    if (stopped || !isLostStatus(status)) {
      return;
    }
    recovering = true;
    deps.log?.("managed daemon stopped answering; asking desktop to recover it", {
      serverId,
      status,
    });
    try {
      await deps.recover();
    } catch (error) {
      deps.log?.("managed daemon recovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      recovering = false;
      lastAttemptAt = now();
    }
    evaluate();
  };

  function evaluate(): void {
    if (stopped) {
      return;
    }
    const managedServerId = deps.getManagedServerId();
    if (managedServerId !== serverId) {
      serverId = managedServerId;
      wasOnline = false;
      clearTimer();
    }
    const status = currentStatus();
    if (status === "online") {
      wasOnline = true;
      clearTimer();
      return;
    }
    if (!wasOnline || !isLostStatus(status) || timer || recovering) {
      return;
    }
    const cooldownLeft = lastAttemptAt === null ? 0 : lastAttemptAt + cooldownMs - now();
    timer = setTimeout(
      () => {
        void runRecovery();
      },
      Math.max(delayMs, cooldownLeft),
    );
  }

  const unsubscribeServerId = deps.subscribeManagedServerId(evaluate);
  const unsubscribeStatus = deps.subscribeConnectionStatus(evaluate);
  evaluate();

  return () => {
    stopped = true;
    clearTimer();
    unsubscribeServerId();
    unsubscribeStatus();
  };
}
