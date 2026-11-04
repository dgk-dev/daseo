import { create } from "zustand";

// Daseo delta 79: opening a History search result lands on the message that matched. The row
// press records the timeline row to open at; the agent's stream view takes it once its
// timeline is ready and scrolls there. Memory only: a restarted app opens sessions as usual.
export interface PendingTimelineJump {
  serverId: string;
  agentId: string;
  seq: number;
}

/** A jump the session never got to (it failed to open) must not fire on a later visit. */
const PENDING_JUMP_TTL_MS = 30_000;

interface TimelineJumpStoreState {
  pending: (PendingTimelineJump & { requestedAt: number }) | null;
  request: (jump: PendingTimelineJump) => void;
  clear: () => void;
  /** Clears the pending jump if it is this agent's, returning its row. */
  take: (serverId: string, agentId: string) => number | null;
}

export const useTimelineJumpStore = create<TimelineJumpStoreState>()((set, get) => ({
  pending: null,
  request: (jump) => set({ pending: { ...jump, requestedAt: Date.now() } }),
  clear: () => set({ pending: null }),
  take: (serverId, agentId) => {
    const pending = get().pending;
    if (!pending || pending.serverId !== serverId || pending.agentId !== agentId) return null;
    set({ pending: null });
    return Date.now() - pending.requestedAt <= PENDING_JUMP_TTL_MS ? pending.seq : null;
  },
}));
