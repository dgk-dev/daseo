import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { z } from "zod";
import { readValidatedJson, readValidatedString } from "@/storage/validated-storage";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./types";
import { getOrCreateDeviceSigningIdentity } from "@/security/device-identity";
import { resolveAppVersion } from "@/utils/app-version";
import { sendOsNotification } from "@/utils/os-notifications";

const STORAGE_PREFIX = "@paseo:expo-push-token:";
const ExpoPushTokenSchema = z.string().trim().min(1);
const NotificationCursorSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
});

function storageKey(serverId: string): string {
  return `${STORAGE_PREFIX}${serverId}`;
}

function cursorStorageKey(serverId: string): string {
  return `@paseo:notification-cursor:${serverId}`;
}

function usesDirectFcmPush(): boolean {
  const constants = Constants as unknown as {
    expoConfig?: { extra?: { directFcmPush?: unknown } };
  };
  return constants.expoConfig?.extra?.directFcmPush === true;
}

function getExpoProjectId(): string | null {
  const fromEas = ExpoPushTokenSchema.safeParse(Constants.easConfig?.projectId);
  if (fromEas.success) return fromEas.data;
  const fromExtra = ExpoPushTokenSchema.safeParse(Constants.expoConfig?.extra?.eas?.projectId);
  return fromExtra.success ? fromExtra.data : null;
}

async function ensurePushPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === Notifications.PermissionStatus.GRANTED) return true;
  if (!existing.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === Notifications.PermissionStatus.GRANTED;
}

async function resolveToken(serverId: string): Promise<string | null> {
  const key = storageKey(serverId);
  const cached = await readValidatedString(AsyncStorage, key, ExpoPushTokenSchema);
  if (!(await ensurePushPermission())) {
    await AsyncStorage.removeItem(key);
    return null;
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("agent-updates", {
      name: "Agent updates",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  let token: string;
  if (Platform.OS === "android" && usesDirectFcmPush()) {
    const result = await Notifications.getDevicePushTokenAsync();
    const deviceToken = typeof result.data === "string" ? result.data.trim() : "";
    if (!deviceToken) return cached;
    token = `fcm:${deviceToken}`;
  } else {
    const projectId = getExpoProjectId();
    if (!projectId) {
      console.warn("[PushNotifications] Missing EAS projectId; cannot fetch Expo push token");
      return cached;
    }
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    token = result.data.trim();
    if (!token) return cached;
  }
  await AsyncStorage.setItem(key, token);
  return token;
}

export function startSubscription(input: StartPushNotificationsInput): () => void {
  let stopped = false;
  let token: string | null = null;
  let deviceId: string | null = null;
  let notificationCursor: { epoch: string; seq: number } | null = null;
  const register = () => {
    if (!stopped && token && deviceId && input.client.isConnected) {
      input.client.registerPushToken(token, {
        deviceId,
        platform: Platform.OS,
        appVersion: resolveAppVersion() ?? undefined,
        ...(notificationCursor ? { notificationCursor } : {}),
      });
    }
  };

  void Promise.all([
    resolveToken(input.serverId),
    getOrCreateDeviceSigningIdentity(),
    readValidatedJson(AsyncStorage, cursorStorageKey(input.serverId), NotificationCursorSchema),
  ])
    .then(([resolved, identity, cursor]) => {
      if (stopped) return undefined;
      token = resolved;
      deviceId = identity.deviceId;
      notificationCursor = cursor;
      register();
      return undefined;
    })
    .catch((error) => console.warn("[PushNotifications] Failed to register push token", error));

  const unsubscribe = input.client.subscribeConnectionStatus((state) => {
    if (state.status === "connected") register();
  });
  const rememberDeliveredNotification = (data: Record<string, unknown> | null | undefined) => {
    const epoch = data?.paseoNotificationEpoch;
    const seq = data?.paseoNotificationSeq;
    if (typeof epoch !== "string" || typeof seq !== "number" || !Number.isInteger(seq)) return;
    if (notificationCursor?.epoch === epoch && notificationCursor.seq >= seq) return;
    notificationCursor = { epoch, seq };
    void AsyncStorage.setItem(cursorStorageKey(input.serverId), JSON.stringify(notificationCursor));
  };
  const receivedSubscription = Notifications.addNotificationReceivedListener((notification) => {
    rememberDeliveredNotification(notification.request.content.data);
  });
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    rememberDeliveredNotification(response?.notification.request.content.data);
    return undefined;
  });

  const unsubscribeCatchUp = input.client.on("push.notification.catch_up", (message) => {
    if (message.type !== "push.notification.catch_up") return;
    void (async () => {
      const { epoch, events, quarantinedThroughSeq } = message.payload;
      let nextSeq = notificationCursor?.epoch === epoch ? notificationCursor.seq : 0;
      for (const event of events) {
        if (event.epoch !== epoch || event.seq <= nextSeq) continue;
        await sendOsNotification({
          title: event.payload.title,
          body: event.payload.body,
          data: event.payload.data,
        });
        nextSeq = event.seq;
        notificationCursor = { epoch, seq: nextSeq };
        await AsyncStorage.setItem(
          cursorStorageKey(input.serverId),
          JSON.stringify(notificationCursor),
        );
      }
      if (events.length === 0 && quarantinedThroughSeq > nextSeq) {
        notificationCursor = { epoch, seq: quarantinedThroughSeq };
        await AsyncStorage.setItem(
          cursorStorageKey(input.serverId),
          JSON.stringify(notificationCursor),
        );
      }
    })().catch((error) =>
      console.warn("[PushNotifications] Failed to apply notification catch-up", error),
    );
  });

  return () => {
    stopped = true;
    unsubscribe();
    unsubscribeCatchUp();
    receivedSubscription.remove();
  };
}

export async function revokeSubscription(input: RevokePushNotificationsInput): Promise<void> {
  const key = storageKey(input.serverId);
  const token = await readValidatedString(AsyncStorage, key, ExpoPushTokenSchema);
  if (
    token &&
    input.client?.isConnected &&
    input.client.getLastServerInfoMessage()?.features?.pushTokenRevocation === true
  ) {
    try {
      await input.client.unregisterPushToken(token);
    } catch (error) {
      console.warn("[PushNotifications] Failed to revoke push token", error);
    }
  }
  await AsyncStorage.removeItem(key);
}
