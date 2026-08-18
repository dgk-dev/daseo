import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type pino from "pino";
import { z } from "zod";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import type { PushPayload } from "./push-service.js";

const MAX_EVENTS = 256;
const StoredEventSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().positive(),
  notificationId: z.string(),
  payload: z.object({
    title: z.string(),
    body: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
});
const StoreSchema = z.object({
  version: z.literal(1),
  epoch: z.string(),
  nextSeq: z.number().int().positive(),
  events: z.array(StoredEventSchema),
});

export type PushNotificationEvent = z.infer<typeof StoredEventSchema>;

export class PushNotificationEventStore {
  private epoch: string = randomUUID();
  private nextSeq = 1;
  private events: PushNotificationEvent[] = [];

  constructor(
    private readonly filePath: string,
    private readonly logger: pino.Logger,
  ) {
    this.load();
  }

  append(payload: PushPayload): { event: PushNotificationEvent; payload: PushPayload } {
    const event: PushNotificationEvent = {
      epoch: this.epoch,
      seq: this.nextSeq++,
      notificationId: randomUUID(),
      payload,
    };
    this.events = [...this.events, event].slice(-MAX_EVENTS);
    this.persist();
    return {
      event,
      payload: {
        ...payload,
        data: {
          ...payload.data,
          paseoNotificationEpoch: event.epoch,
          paseoNotificationSeq: event.seq,
          paseoNotificationId: event.notificationId,
        },
      },
    };
  }

  catchUp(cursor?: { epoch: string; seq: number } | null): {
    epoch: string;
    events: PushNotificationEvent[];
    quarantinedThroughSeq: number;
  } {
    if (!cursor) {
      return { epoch: this.epoch, events: [], quarantinedThroughSeq: this.nextSeq - 1 };
    }
    const events =
      cursor.epoch === this.epoch
        ? this.events.filter((event) => event.seq > cursor.seq)
        : [...this.events];
    return {
      epoch: this.epoch,
      events,
      quarantinedThroughSeq: events.at(-1)?.seq ?? this.nextSeq - 1,
    };
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      ensurePrivateFile(this.filePath);
      const parsed = StoreSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
      this.epoch = parsed.epoch;
      this.nextSeq = parsed.nextSeq;
      this.events = parsed.events;
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to load push notification events");
    }
  }

  private persist(): void {
    writePrivateFileAtomicSync(
      this.filePath,
      `${JSON.stringify(
        {
          version: 1,
          epoch: this.epoch,
          nextSeq: this.nextSeq,
          events: this.events,
        },
        null,
        2,
      )}\n`,
    );
  }
}
