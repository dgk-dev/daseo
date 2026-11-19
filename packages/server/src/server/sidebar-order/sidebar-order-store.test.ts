import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "../messages.js";
import { SidebarOrderSessionChannel } from "./sidebar-order-session-channel.js";
import { SidebarOrderStore } from "./sidebar-order-store.js";

const logger = pino({ level: "silent" });

const ORDER = {
  projectOrder: ["project-b", "project-a"],
  pinnedWorkspaceOrder: ["srv_1:ws-2", "srv_1:ws-1"],
  workspaceOrderByProject: { "project-a": ["srv_1:ws-3", "srv_1:ws-4"] },
};

function createHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-sidebar-order-"));
}

function createStore(home: string): SidebarOrderStore {
  return new SidebarOrderStore({ filePath: path.join(home, "sidebar-order.json"), logger });
}

function createChannel(store: SidebarOrderStore): {
  channel: SidebarOrderSessionChannel;
  emitted: SessionOutboundMessage[];
} {
  const emitted: SessionOutboundMessage[] = [];
  const channel = new SidebarOrderSessionChannel({
    store,
    emit: (message) => emitted.push(message),
    logger,
  });
  return { channel, emitted };
}

describe("SidebarOrderStore (delta 133)", () => {
  it("has no order until a client stores one, then keeps it across a restart", async () => {
    const home = createHome();
    const store = createStore(home);
    expect(await store.get()).toBeNull();

    await store.set(ORDER, null);
    expect(await store.get()).toEqual(ORDER);

    expect(await createStore(home).get()).toEqual(ORDER);
  });

  it("copies an unreadable file aside and starts without an order", async () => {
    const home = createHome();
    const filePath = path.join(home, "sidebar-order.json");
    writeFileSync(filePath, "{not json");

    const store = createStore(home);
    expect(await store.get()).toBeNull();

    const backups = readdirSync(home).filter((name) =>
      name.startsWith("sidebar-order.json.corrupt-"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(home, backups[0]), "utf8")).toBe("{not json");

    await store.set(ORDER, null);
    expect(await createStore(home).get()).toEqual(ORDER);
  });
});

describe("SidebarOrderSessionChannel (delta 133)", () => {
  it("round-trips the order and pushes it to the other subscribed session, not the sender", async () => {
    const store = createStore(createHome());
    const mac = createChannel(store);
    const phone = createChannel(store);

    await phone.channel.handle({ type: "sidebar.order.get.request", requestId: "g1" });
    expect(phone.emitted).toEqual([
      { type: "sidebar.order.get.response", payload: { requestId: "g1", order: null } },
    ]);

    await mac.channel.handle({ type: "sidebar.order.set.request", order: ORDER, requestId: "s1" });
    expect(mac.emitted).toEqual([
      {
        type: "sidebar.order.set.response",
        payload: { requestId: "s1", order: ORDER, error: null },
      },
    ]);
    expect(phone.emitted.slice(1)).toEqual([
      { type: "sidebar.order.update", payload: { order: ORDER } },
    ]);

    await phone.channel.handle({ type: "sidebar.order.get.request", requestId: "g2" });
    expect(phone.emitted.at(-1)).toEqual({
      type: "sidebar.order.get.response",
      payload: { requestId: "g2", order: ORDER },
    });
  });

  it("never pushes to a session that did not ask (an app without the feature)", async () => {
    const store = createStore(createHome());
    const oldApp = createChannel(store);
    const newApp = createChannel(store);

    await newApp.channel.handle({
      type: "sidebar.order.set.request",
      order: ORDER,
      requestId: "s1",
    });

    expect(oldApp.emitted).toEqual([]);
  });

  it("stops pushing after the session is disposed", async () => {
    const store = createStore(createHome());
    const writer = createChannel(store);
    const reader = createChannel(store);
    await reader.channel.handle({ type: "sidebar.order.get.request", requestId: "g1" });
    reader.channel.dispose();

    await writer.channel.handle({
      type: "sidebar.order.set.request",
      order: ORDER,
      requestId: "s1",
    });

    expect(reader.emitted).toHaveLength(1);
  });

  it("leaves other message types to the session", () => {
    const store = createStore(createHome());
    const { channel } = createChannel(store);
    expect(
      channel.handle({ type: "workspace.discard_empty.request", workspaceId: "w", requestId: "r" }),
    ).toBeUndefined();
  });
});
