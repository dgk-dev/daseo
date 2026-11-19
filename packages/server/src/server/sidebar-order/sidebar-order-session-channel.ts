import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { SidebarOrderStore } from "./sidebar-order-store.js";

type SidebarOrderRequest = Extract<
  SessionInboundMessage,
  { type: "sidebar.order.get.request" | "sidebar.order.set.request" }
>;

interface SidebarOrderSessionChannelOptions {
  /** Absent when the runtime keeps no shared order; the channel then leaves every message. */
  store: SidebarOrderStore | null | undefined;
  emit: (message: SessionOutboundMessage) => void;
  logger: pino.Logger;
}

/**
 * Daseo delta 133: one session's side of the shared sidebar order. A session receives
 * sidebar.order.update only after it asked with sidebar.order.get.request, so an app that does
 * not know the feature never gets a message type it cannot parse, and the session that stored a
 * change gets only its set response.
 */
export class SidebarOrderSessionChannel {
  private readonly store: SidebarOrderStore | null;
  private readonly emit: (message: SessionOutboundMessage) => void;
  private readonly logger: pino.Logger;
  private unsubscribe: (() => void) | null = null;

  constructor(options: SidebarOrderSessionChannelOptions) {
    this.store = options.store ?? null;
    this.emit = options.emit;
    this.logger = options.logger;
  }

  handle(message: SessionInboundMessage): Promise<void> | undefined {
    const store = this.store;
    if (!store) return undefined;
    if (message.type === "sidebar.order.get.request") return this.handleGet(store, message);
    if (message.type === "sidebar.order.set.request") return this.handleSet(store, message);
    return undefined;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private subscribe(store: SidebarOrderStore): void {
    if (this.unsubscribe) return;
    this.unsubscribe = store.onChange((order, origin) => {
      if (origin === this) return;
      this.emit({ type: "sidebar.order.update", payload: { order } });
    });
  }

  private async handleGet(
    store: SidebarOrderStore,
    request: Extract<SidebarOrderRequest, { type: "sidebar.order.get.request" }>,
  ): Promise<void> {
    this.subscribe(store);
    const order = await store.get();
    this.emit({
      type: "sidebar.order.get.response",
      payload: { requestId: request.requestId, order },
    });
  }

  private async handleSet(
    store: SidebarOrderStore,
    request: Extract<SidebarOrderRequest, { type: "sidebar.order.set.request" }>,
  ): Promise<void> {
    this.subscribe(store);
    try {
      const order = await store.set(request.order, this);
      this.emit({
        type: "sidebar.order.set.response",
        payload: { requestId: request.requestId, order, error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to store sidebar order");
      this.emit({
        type: "sidebar.order.set.response",
        payload: { requestId: request.requestId, order: null, error: getErrorMessage(error) },
      });
    }
  }
}
