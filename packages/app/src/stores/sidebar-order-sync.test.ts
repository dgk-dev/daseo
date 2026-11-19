import { describe, expect, it } from "vitest";
import type { SidebarOrderSnapshot } from "./sidebar-order-store";
import { SidebarOrderSync, type SidebarOrderSyncClient } from "./sidebar-order-sync";

const EMPTY: SidebarOrderSnapshot = {
  projectOrder: [],
  pinnedWorkspaceOrder: [],
  workspaceOrderByProject: {},
};

const PHONE_ORDER: SidebarOrderSnapshot = {
  projectOrder: ["project-a", "project-b"],
  pinnedWorkspaceOrder: ["srv:ws-1"],
  workspaceOrderByProject: { "project-a": ["srv:ws-2", "srv:ws-3"] },
};

const MAC_ORDER: SidebarOrderSnapshot = {
  projectOrder: ["project-b", "project-a"],
  pinnedWorkspaceOrder: ["srv:ws-1"],
  workspaceOrderByProject: { "project-a": ["srv:ws-3", "srv:ws-2"] },
};

type UpdateHandler = (message: {
  type: "sidebar.order.update";
  payload: { order: SidebarOrderSnapshot };
}) => void;

class FakeDaemon {
  stored: SidebarOrderSnapshot | null;
  readonly sets: SidebarOrderSnapshot[] = [];
  private readonly handlers = new Set<UpdateHandler>();

  constructor(stored: SidebarOrderSnapshot | null) {
    this.stored = stored;
  }

  readonly client = {
    getSidebarOrder: async () => this.stored,
    setSidebarOrder: async (order: SidebarOrderSnapshot) => {
      this.stored = order;
      this.sets.push(order);
      return order;
    },
    on: (_type: "sidebar.order.update", handler: UpdateHandler) => {
      this.handlers.add(handler);
      return () => {
        this.handlers.delete(handler);
      };
    },
  } as unknown as SidebarOrderSyncClient;

  push(order: SidebarOrderSnapshot): void {
    for (const handler of this.handlers) {
      handler({ type: "sidebar.order.update", payload: { order } });
    }
  }

  get listenerCount(): number {
    return this.handlers.size;
  }
}

function createSync(initial: SidebarOrderSnapshot) {
  let local = initial;
  const timers: Array<() => void> = [];
  const sync = new SidebarOrderSync({
    readLocal: () => local,
    replaceLocal: (order) => {
      local = order;
    },
    whenLocalReady: async () => undefined,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
    warn: () => undefined,
  });
  return {
    sync,
    getLocal: () => local,
    setLocal: (order: SidebarOrderSnapshot) => {
      local = order;
    },
    fireTimers: () => {
      for (const timer of timers.splice(0)) timer();
    },
  };
}

describe("SidebarOrderSync first contact (delta 133)", () => {
  it("uploads the local order when the daemon has none", async () => {
    const daemon = new FakeDaemon(null);
    const phone = createSync(PHONE_ORDER);

    await phone.sync.attach("srv", daemon.client);

    expect(daemon.sets).toEqual([PHONE_ORDER]);
    expect(phone.getLocal()).toEqual(PHONE_ORDER);
  });

  it("replaces the local order with the daemon's", async () => {
    const daemon = new FakeDaemon(MAC_ORDER);
    const phone = createSync(PHONE_ORDER);

    await phone.sync.attach("srv", daemon.client);

    expect(phone.getLocal()).toEqual(MAC_ORDER);
    expect(daemon.sets).toEqual([]);
  });

  it("stores nothing when neither side has an order", async () => {
    const daemon = new FakeDaemon(null);
    const fresh = createSync(EMPTY);

    await fresh.sync.attach("srv", daemon.client);

    expect(daemon.sets).toEqual([]);
    expect(daemon.stored).toBeNull();
  });

  it("uploads a drag made while no daemon was attached instead of losing it", async () => {
    const daemon = new FakeDaemon(MAC_ORDER);
    const phone = createSync(PHONE_ORDER);
    phone.sync.publish();

    await phone.sync.attach("srv", daemon.client);

    expect(daemon.stored).toEqual(PHONE_ORDER);
    expect(phone.getLocal()).toEqual(PHONE_ORDER);
  });
});

describe("SidebarOrderSync live changes (delta 133)", () => {
  it("publishes a drag to the daemon and applies an order pushed from another device", async () => {
    const daemon = new FakeDaemon(PHONE_ORDER);
    const phone = createSync(PHONE_ORDER);
    await phone.sync.attach("srv", daemon.client);

    phone.setLocal(MAC_ORDER);
    phone.sync.publish();
    await Promise.resolve();
    expect(daemon.sets).toEqual([MAC_ORDER]);

    daemon.push(PHONE_ORDER);
    expect(phone.getLocal()).toEqual(PHONE_ORDER);
  });

  it("holds a push during a drag and applies it when the drag changed nothing", async () => {
    const daemon = new FakeDaemon(PHONE_ORDER);
    const phone = createSync(PHONE_ORDER);
    await phone.sync.attach("srv", daemon.client);

    phone.sync.beginDrag();
    daemon.push(MAC_ORDER);
    expect(phone.getLocal()).toEqual(PHONE_ORDER);

    phone.sync.endDrag({ changed: false });
    expect(phone.getLocal()).toEqual(MAC_ORDER);
  });

  it("drops a held push when the drag stored its own order (last write wins)", async () => {
    const daemon = new FakeDaemon(PHONE_ORDER);
    const phone = createSync(PHONE_ORDER);
    await phone.sync.attach("srv", daemon.client);
    const dragged: SidebarOrderSnapshot = { ...PHONE_ORDER, projectOrder: ["project-b"] };

    phone.sync.beginDrag();
    daemon.push(MAC_ORDER);
    phone.setLocal(dragged);
    phone.sync.publish();
    phone.sync.endDrag({ changed: true });

    expect(phone.getLocal()).toEqual(dragged);
  });

  it("releases a held push when a drag never reports its end", async () => {
    const daemon = new FakeDaemon(PHONE_ORDER);
    const phone = createSync(PHONE_ORDER);
    await phone.sync.attach("srv", daemon.client);

    phone.sync.beginDrag();
    daemon.push(MAC_ORDER);
    phone.fireTimers();

    expect(phone.getLocal()).toEqual(MAC_ORDER);
  });

  it("ignores pushes after the host is detached", async () => {
    const daemon = new FakeDaemon(PHONE_ORDER);
    const phone = createSync(PHONE_ORDER);
    await phone.sync.attach("srv", daemon.client);

    phone.sync.detach("srv");
    daemon.push(MAC_ORDER);

    expect(daemon.listenerCount).toBe(0);
    expect(phone.getLocal()).toEqual(PHONE_ORDER);
  });
});
