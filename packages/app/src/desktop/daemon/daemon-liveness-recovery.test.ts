import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { startDaemonLivenessRecovery } from "./daemon-liveness-recovery";

function createHarness() {
  let serverId: string | null = "server-1";
  const statuses = new Map<string, HostRuntimeConnectionStatus>();
  const serverIdListeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  const recover = vi.fn(async () => undefined);
  const stop = startDaemonLivenessRecovery({
    getManagedServerId: () => serverId,
    subscribeManagedServerId: (listener) => {
      serverIdListeners.add(listener);
      return () => serverIdListeners.delete(listener);
    },
    getConnectionStatus: (id) => statuses.get(id) ?? "connecting",
    subscribeConnectionStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    recover,
  });
  return {
    recover,
    stop,
    setStatus(next: HostRuntimeConnectionStatus) {
      if (serverId) statuses.set(serverId, next);
      for (const listener of statusListeners) listener();
    },
    setServerId(next: string | null) {
      serverId = next;
      for (const listener of serverIdListeners) listener();
    },
  };
}

describe("desktop daemon liveness recovery (delta 126)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not act on a daemon that was never online (start-up owns that)", async () => {
    const harness = createHarness();
    harness.setStatus("offline");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.recover).not.toHaveBeenCalled();
    harness.stop();
  });

  it("asks the desktop to recover 5 s after the daemon stopped answering", async () => {
    const harness = createHarness();
    harness.setStatus("online");
    harness.setStatus("connecting");
    harness.setStatus("offline");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.recover).toHaveBeenCalledTimes(1);
    harness.stop();
  });

  it("does nothing when the connection comes back on its own", async () => {
    const harness = createHarness();
    harness.setStatus("online");
    harness.setStatus("offline");
    await vi.advanceTimersByTimeAsync(3_000);
    harness.setStatus("online");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.recover).not.toHaveBeenCalled();
    harness.stop();
  });

  it("ignores a deliberate disconnect", async () => {
    const harness = createHarness();
    harness.setStatus("online");
    harness.setStatus("idle");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.recover).not.toHaveBeenCalled();
    harness.stop();
  });

  it("retries at most once a minute while the daemon stays unreachable", async () => {
    const harness = createHarness();
    harness.setStatus("online");
    harness.setStatus("error");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.recover).toHaveBeenCalledTimes(1);
    harness.setStatus("offline");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(harness.recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.recover).toHaveBeenCalledTimes(2);
    harness.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.recover).toHaveBeenCalledTimes(2);
  });

  it("starts over when the managed daemon changes", async () => {
    const harness = createHarness();
    harness.setStatus("online");
    harness.setServerId("server-2");
    harness.setStatus("offline");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.recover).not.toHaveBeenCalled();
    harness.stop();
  });
});
