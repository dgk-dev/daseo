import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getClientMock = vi.fn();
const sessionsState: { sessions: Record<string, { serverInfo: unknown }> } = { sessions: {} };

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: getClientMock }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => sessionsState },
}));
vi.mock("@/utils/app-version", () => ({ resolveAppVersion: () => "0.0.0-test" }));

import {
  flushClientDiagnostics,
  peekPendingClientDiagnostics,
  recordClientDiagnostic,
  resetClientDiagnosticsForTests,
} from "./client-diagnostics";

describe("client diagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetClientDiagnosticsForTests();
    getClientMock.mockReset();
    sessionsState.sessions = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("folds a repeated message into one event with a count", () => {
    recordClientDiagnostic({ level: "error", scope: "toast", message: "Transport not connected" });
    recordClientDiagnostic({ level: "error", scope: "toast", message: "Transport not connected" });
    recordClientDiagnostic({ level: "warn", scope: "console", message: "other" });
    const pending = peekPendingClientDiagnostics();
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ scope: "toast", count: 2 });
    expect(pending[0]).not.toHaveProperty("key");
  });

  it("drops empty messages and caps the queue", () => {
    recordClientDiagnostic({ level: "error", scope: "toast", message: "   " });
    expect(peekPendingClientDiagnostics()).toHaveLength(0);
  });

  it("reports to a daemon that advertises the feature and keeps the batch when it fails", async () => {
    const report = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({
      accepted: 1,
    });
    sessionsState.sessions = {
      mac: { serverInfo: { features: { clientDiagnostics: true } } },
      other: { serverInfo: { features: {} } },
    };
    getClientMock.mockImplementation((serverId: string) =>
      serverId === "mac" ? { reportClientDiagnostics: report } : null,
    );
    recordClientDiagnostic({ level: "error", scope: "render", message: "boom" });

    await flushClientDiagnostics();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      appVersion: "0.0.0-test",
      events: [{ scope: "render", message: "boom", level: "error" }],
    });
    expect(peekPendingClientDiagnostics()).toHaveLength(1);

    await flushClientDiagnostics();
    expect(report).toHaveBeenCalledTimes(2);
    expect(peekPendingClientDiagnostics()).toHaveLength(0);
  });

  it("holds events while no daemon with the feature is connected", async () => {
    sessionsState.sessions = { mac: { serverInfo: { features: {} } } };
    getClientMock.mockReturnValue({ reportClientDiagnostics: vi.fn() });
    recordClientDiagnostic({ level: "warn", scope: "promise", message: "later" });
    await flushClientDiagnostics();
    expect(peekPendingClientDiagnostics()).toHaveLength(1);
  });
});
