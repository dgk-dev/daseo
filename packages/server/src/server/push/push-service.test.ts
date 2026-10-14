import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { PushService } from "./push-service.js";

afterEach(() => vi.unstubAllGlobals());
for (const error of ["InvalidCredentials", "DeviceNotRegistered"]) {
  test(`Expo ${error} only revokes an actually unregistered device`, async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ status: "error", details: { error } }] })),
        ),
    );
    const revoke = vi.fn();
    await new PushService(createTestLogger(), revoke).sendPush(["ExponentPushToken[test]"], {
      title: "Test",
      body: "Test",
    });
    expect(revoke).toHaveBeenCalledTimes(error === "DeviceNotRegistered" ? 1 : 0);
  });
}

test("Expo pushes carry the Android channel for their attention reason", async () => {
  const fetchMock = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ data: [{ status: "ok", id: "ticket" }] })),
    );
  vi.stubGlobal("fetch", fetchMock);
  const service = new PushService(createTestLogger(), vi.fn());

  for (const data of [
    { reason: "permission" },
    { reason: "error" },
    { reason: "finished" },
    undefined,
  ]) {
    await service.sendPush(["ExponentPushToken[test]"], { title: "Agent", body: "Body", data });
  }

  const messages = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body))[0]);
  expect(messages.map((message) => [message.sound, message.channelId])).toEqual([
    ["default", "agent-needs-you"],
    ["default", "agent-needs-you"],
    ["default", "agent-updates"],
    ["default", "agent-updates"],
  ]);
});
