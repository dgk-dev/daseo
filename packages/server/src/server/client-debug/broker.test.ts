import { describe, expect, it } from "vitest";
import type { ClientDebugCollectRequest } from "@getpaseo/protocol/messages";
import { ClientDebugBroker, getClientDebugCapability } from "./broker.js";
import { summarizeClientDebugDump } from "./tools.js";

function payload(requestId: string) {
  return {
    requestId,
    platform: "android",
    appVersion: "0.5.78",
    collectedAt: 1_700_000_000_000,
    console: [
      { at: 1, level: "log", message: "boot" },
      { at: 2, level: "error", message: "composer lost transcript" },
    ],
    logcat:
      "10-26 07:12:01.123  1234  1250 I ReactNativeJS: fine\n10-26 07:12:02.000  1234  1250 E AndroidRuntime: FATAL boom\n",
    exitInfo: [{ at: 3, reason: "anr", description: "Input dispatching timed out" }],
  };
}

describe("ClientDebugBroker", () => {
  it("sends to the newest phone and resolves with its reply", async () => {
    const sent: Array<{ client: string; request: ClientDebugCollectRequest }> = [];
    const broker = new ClientDebugBroker({ createRequestId: () => "req-1" });
    broker.register({
      clientId: "desktop",
      platform: "web",
      appVersion: null,
      send: (request) => sent.push({ client: "desktop", request }),
    });
    broker.register({
      clientId: "fold",
      platform: "android",
      appVersion: "0.5.78",
      send: (request) => sent.push({ client: "fold", request }),
    });
    const pending = broker.collect({ maxLogcatLines: 10 });
    expect(sent).toEqual([
      {
        client: "fold",
        request: { type: "client.debug.collect.request", requestId: "req-1", maxLogcatLines: 10 },
      },
    ]);
    expect(
      broker.receiveResponse({ type: "client.debug.collect.response", payload: payload("req-1") }),
    ).toBe(true);
    const result = await pending;
    expect(result.ok && result.target.clientId).toBe("fold");
    expect(result.ok && result.payload.console).toHaveLength(2);
  });

  it("fails pending requests when the app disconnects, and ignores a stale unregister", async () => {
    const broker = new ClientDebugBroker({ createRequestId: () => "req-2" });
    const first = broker.register({
      clientId: "fold",
      platform: "android",
      appVersion: null,
      send: () => {},
    });
    broker.register({ clientId: "fold", platform: "android", appVersion: null, send: () => {} });
    first();
    expect(broker.list()).toHaveLength(1);
    const pending = broker.collect({});
    broker.unregister("fold");
    await expect(pending).resolves.toMatchObject({ ok: false, code: "disconnected" });
    await expect(broker.collect({})).resolves.toMatchObject({ ok: false, code: "no_client" });
  });

  it("times out when the app never answers", async () => {
    const broker = new ClientDebugBroker();
    broker.register({ clientId: "fold", platform: "android", appVersion: null, send: () => {} });
    await expect(broker.collect({ timeoutMs: 5 })).resolves.toMatchObject({
      ok: false,
      code: "timeout",
    });
  });

  it("reads the capability only when it names a platform", () => {
    expect(getClientDebugCapability({ debug_collect: { platform: "android" } })).toEqual({
      platform: "android",
    });
    expect(getClientDebugCapability({ debug_collect: true })).toBeNull();
    expect(getClientDebugCapability(null)).toBeNull();
  });
});

describe("summarizeClientDebugDump", () => {
  const target = { clientId: "fold", platform: "android", appVersion: "0.5.78", connectedAt: 0 };
  it("highlights errors, exits, and logcat E lines", () => {
    const summary = summarizeClientDebugDump({ path: "/tmp/x.log", target, payload: payload("r") });
    expect(summary).toContain("composer lost transcript");
    expect(summary).toContain("FATAL boom");
    expect(summary).not.toContain("I ReactNativeJS: fine");
    expect(summary).toContain("anr: Input dispatching timed out");
  });
  it("filters every line with grep", () => {
    const summary = summarizeClientDebugDump({
      path: "/tmp/x.log",
      target,
      payload: payload("r"),
      grep: "boot",
    });
    expect(summary).toContain('Lines matching "boot" (1');
    expect(summary).toContain("boot");
  });
});
