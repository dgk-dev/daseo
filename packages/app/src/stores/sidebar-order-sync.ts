import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSidebarOrderStore, type SidebarOrderSnapshot } from "@/stores/sidebar-order-store";

/**
 * Daseo delta 133: keeps the sidebar order (projects, pinned rows, sessions within a project) the
 * same on every device through the daemon. The local store stays the cache the sidebar renders
 * from, so it paints at once offline; this module only moves whole orders between it and each
 * connected daemon that advertises `sidebarOrderSync`.
 *
 * - On connect: the daemon's order replaces the local one. A daemon without one gets the local
 *   order, which becomes the shared one. A drag made while no daemon was reachable is uploaded
 *   instead of being replaced.
 * - On a drag end that changed the order: the whole order goes to every attached daemon.
 * - A pushed order waits while a drag is in progress; it is dropped if that drag changes the
 *   order (last write wins), and applied otherwise.
 */
export type SidebarOrderSyncClient = Pick<
  DaemonClient,
  "getSidebarOrder" | "setSidebarOrder" | "on"
>;

export interface SidebarOrderSyncDeps {
  readLocal: () => SidebarOrderSnapshot;
  replaceLocal: (order: SidebarOrderSnapshot) => void;
  /** Resolves once the persisted local order has been read from storage. */
  whenLocalReady: () => Promise<void>;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  warn: (message: string, error: unknown) => void;
}

interface Attachment {
  client: SidebarOrderSyncClient;
  unsubscribe: () => void;
}

// A drag whose end never reaches us (a cancelled native gesture) must not hold pushes forever.
const DRAG_HOLD_LIMIT_MS = 30_000;

function isEmptyOrder(order: SidebarOrderSnapshot): boolean {
  return (
    order.projectOrder.length === 0 &&
    order.pinnedWorkspaceOrder.length === 0 &&
    Object.keys(order.workspaceOrderByProject).length === 0
  );
}

function ordersEqual(a: SidebarOrderSnapshot, b: SidebarOrderSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class SidebarOrderSync {
  private readonly deps: SidebarOrderSyncDeps;
  private readonly attachments = new Map<string, Attachment>();
  private dragActive = false;
  private dragTimer: unknown = null;
  private heldRemote: SidebarOrderSnapshot | null = null;
  private unsyncedLocalEdit = false;

  constructor(deps: SidebarOrderSyncDeps) {
    this.deps = deps;
  }

  async attach(serverId: string, client: SidebarOrderSyncClient): Promise<void> {
    this.detach(serverId);
    const attachment: Attachment = {
      client,
      unsubscribe: client.on("sidebar.order.update", (message) => {
        if (this.attachments.get(serverId) !== attachment) return;
        this.receiveRemote(message.payload.order);
      }),
    };
    this.attachments.set(serverId, attachment);
    try {
      await this.deps.whenLocalReady();
      const remote = await client.getSidebarOrder();
      if (this.attachments.get(serverId) !== attachment) return;
      const local = this.deps.readLocal();
      if ((remote === null || this.unsyncedLocalEdit) && !isEmptyOrder(local)) {
        await this.upload(client, local);
        return;
      }
      if (remote !== null) this.receiveRemote(remote);
    } catch (error) {
      this.deps.warn("[SidebarOrderSync] first contact failed", error);
    }
  }

  detach(serverId: string): void {
    const attachment = this.attachments.get(serverId);
    if (!attachment) return;
    attachment.unsubscribe();
    this.attachments.delete(serverId);
  }

  /** Sends the local order to every attached daemon; call after a drag changed it. */
  publish(): void {
    this.unsyncedLocalEdit = true;
    const local = this.deps.readLocal();
    for (const { client } of this.attachments.values()) {
      void this.upload(client, local).catch((error) => {
        this.deps.warn("[SidebarOrderSync] upload failed", error);
      });
    }
  }

  beginDrag(): void {
    this.dragActive = true;
    if (this.dragTimer !== null) this.deps.clearTimer(this.dragTimer);
    this.dragTimer = this.deps.setTimer(() => {
      this.dragTimer = null;
      this.endDrag({ changed: false });
    }, DRAG_HOLD_LIMIT_MS);
  }

  /** Call after the drag's own order (if any) is stored and published. */
  endDrag(input: { changed: boolean }): void {
    this.dragActive = false;
    if (this.dragTimer !== null) {
      this.deps.clearTimer(this.dragTimer);
      this.dragTimer = null;
    }
    const held = this.heldRemote;
    this.heldRemote = null;
    if (held && !input.changed) this.applyRemote(held);
  }

  private async upload(client: SidebarOrderSyncClient, order: SidebarOrderSnapshot): Promise<void> {
    await client.setSidebarOrder(order);
    this.unsyncedLocalEdit = false;
  }

  private receiveRemote(order: SidebarOrderSnapshot): void {
    if (this.dragActive) {
      this.heldRemote = order;
      return;
    }
    this.applyRemote(order);
  }

  private applyRemote(order: SidebarOrderSnapshot): void {
    if (ordersEqual(order, this.deps.readLocal())) return;
    this.deps.replaceLocal(order);
  }
}

function readLocalSidebarOrder(): SidebarOrderSnapshot {
  const { projectOrder, pinnedWorkspaceOrder, workspaceOrderByProject } =
    useSidebarOrderStore.getState();
  return { projectOrder, pinnedWorkspaceOrder, workspaceOrderByProject };
}

function whenSidebarOrderHydrated(): Promise<void> {
  if (useSidebarOrderStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useSidebarOrderStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

export const sidebarOrderSync = new SidebarOrderSync({
  readLocal: readLocalSidebarOrder,
  replaceLocal: (order) => useSidebarOrderStore.getState().replaceOrder(order),
  whenLocalReady: whenSidebarOrderHydrated,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  warn: (message, error) => console.warn(message, error),
});
