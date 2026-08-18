import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  permissionStatus: "granted",
  canAskAgain: true,
  deviceToken: "device-token",
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
  addNotificationReceivedListener: vi.fn(),
  getLastNotificationResponseAsync: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => mocks.storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      mocks.storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      mocks.storage.delete(key);
    }),
  },
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { directFcmPush: true } } },
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

vi.mock("expo-notifications", () => ({
  PermissionStatus: { GRANTED: "granted" },
  AndroidImportance: { HIGH: 4 },
  getPermissionsAsync: mocks.getPermissionsAsync,
  requestPermissionsAsync: mocks.requestPermissionsAsync,
  getDevicePushTokenAsync: mocks.getDevicePushTokenAsync,
  getExpoPushTokenAsync: mocks.getExpoPushTokenAsync,
  setNotificationChannelAsync: mocks.setNotificationChannelAsync,
  addNotificationReceivedListener: mocks.addNotificationReceivedListener,
  getLastNotificationResponseAsync: mocks.getLastNotificationResponseAsync,
}));

import { startSubscription } from "./subscriptions";

function createClient() {
  let connectionHandler: ((state: { status: string }) => void) | null = null;
  return {
    client: {
      isConnected: true,
      registerPushToken: vi.fn(),
      subscribeConnectionStatus: vi.fn((handler) => {
        connectionHandler = handler;
        return vi.fn();
      }),
      on: vi.fn(() => vi.fn()),
    },
    reconnect: () => connectionHandler?.({ status: "connected" }),
  };
}

describe("direct FCM subscriptions", () => {
  beforeEach(() => {
    mocks.storage.clear();
    mocks.permissionStatus = "granted";
    mocks.canAskAgain = true;
    mocks.deviceToken = "device-token";
    mocks.getPermissionsAsync.mockReset().mockImplementation(async () => ({
      status: mocks.permissionStatus,
      canAskAgain: mocks.canAskAgain,
    }));
    mocks.requestPermissionsAsync.mockReset().mockResolvedValue({ status: "granted" });
    mocks.getDevicePushTokenAsync
      .mockReset()
      .mockImplementation(async () => ({ type: "fcm", data: mocks.deviceToken }));
    mocks.getExpoPushTokenAsync.mockReset();
    mocks.setNotificationChannelAsync.mockReset().mockResolvedValue(null);
    mocks.addNotificationReceivedListener.mockReset().mockReturnValue({ remove: vi.fn() });
    mocks.getLastNotificationResponseAsync.mockReset().mockResolvedValue(null);
  });

  test("registers the native Android token with an fcm prefix and high-priority channel", async () => {
    const harness = createClient();
    const stop = startSubscription({
      serverId: "server-1",
      client: harness.client as never,
    });

    await vi.waitFor(() =>
      expect(harness.client.registerPushToken).toHaveBeenCalledWith(
        "fcm:device-token",
        expect.objectContaining({ deviceId: expect.any(String), platform: "android" }),
      ),
    );
    expect(mocks.setNotificationChannelAsync).toHaveBeenCalledWith(
      "agent-updates",
      expect.objectContaining({ importance: 4, sound: "default" }),
    );
    expect(mocks.getExpoPushTokenAsync).not.toHaveBeenCalled();
    stop();
  });

  test("re-registers the same token after a daemon reconnect", async () => {
    const harness = createClient();
    const stop = startSubscription({
      serverId: "server-1",
      client: harness.client as never,
    });
    await vi.waitFor(() => expect(harness.client.registerPushToken).toHaveBeenCalledTimes(1));

    harness.reconnect();

    expect(harness.client.registerPushToken).toHaveBeenCalledTimes(2);
    stop();
  });

  test("does not register or retain a cached token when permission is denied", async () => {
    mocks.permissionStatus = "denied";
    mocks.canAskAgain = false;
    mocks.storage.set("@paseo:expo-push-token:server-1", "fcm:old-token");
    const harness = createClient();
    const stop = startSubscription({
      serverId: "server-1",
      client: harness.client as never,
    });

    await vi.waitFor(() => expect(mocks.getPermissionsAsync).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(mocks.storage.has("@paseo:expo-push-token:server-1")).toBe(false),
    );
    expect(harness.client.registerPushToken).not.toHaveBeenCalled();
    stop();
  });
});
