import type pino from "pino";
import { dirname, join } from "node:path";

import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore, type PushTokenMetadata } from "./token-store.js";
import { PushNotificationEventStore, type PushNotificationEvent } from "./event-store.js";

export type { PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushNotificationCatchUp {
  epoch: string;
  events: PushNotificationEvent[];
  quarantinedThroughSeq: number;
}

export interface PushNotifications {
  renew(
    token: string,
    metadata?: PushTokenMetadata,
    cursor?: { epoch: string; seq: number } | null,
  ): PushNotificationCatchUp;
  revoke(token: string): void;
  revokeDevice(deviceId: string): number;
  send(payload: PushPayload): Promise<void>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(options.logger, (token) => store.revokeToken(token));
  const events = new PushNotificationEventStore(
    join(dirname(options.filePath), "push-events.json"),
    options.logger,
  );
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service.sendPush(tokens, payload));

  return {
    renew(token, metadata, cursor) {
      store.renewToken(token, metadata);
      return events.catchUp(cursor);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    revokeDevice(deviceId) {
      return store.revokeDevice(deviceId);
    },
    async send(payload) {
      const recorded = events.append(payload);
      const notificationKind =
        typeof payload.data?.reason === "string" ? payload.data.reason : undefined;
      const tokens = store.getActiveTokens(notificationKind);
      options.logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) return;
      await deliver(tokens, recorded.payload);
    },
  };
}
