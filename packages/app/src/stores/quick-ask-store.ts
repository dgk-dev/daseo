import { useMemo } from "react";
import { create } from "zustand";

// Daseo delta 64: a composer opened by quick ask starts dictation and auto-sends once. The target
// is a new draft tab (keyed by its draft id) or, when Daseo was already showing a session, that
// session's agent (keyed by its agent id). The marker lives in memory only, so a restarted app
// shows the same composer as an ordinary one.
export interface QuickAskRequest {
  serverId: string;
  workspaceId: string;
  /** The draft id or agent id whose composer dictates. */
  targetId: string;
}

interface QuickAskStoreState {
  pendingByTargetId: Record<string, QuickAskRequest>;
  request: (request: QuickAskRequest) => void;
  finish: (targetId: string) => void;
}

export const useQuickAskStore = create<QuickAskStoreState>()((set) => ({
  pendingByTargetId: {},
  request: (request) =>
    set((state) => ({
      pendingByTargetId: { ...state.pendingByTargetId, [request.targetId]: request },
    })),
  finish: (targetId) =>
    set((state) => {
      if (!state.pendingByTargetId[targetId]) {
        return state;
      }
      const { [targetId]: _finished, ...rest } = state.pendingByTargetId;
      return { pendingByTargetId: rest };
    }),
}));

/** The composer prop for a quick-ask target, or null when it has no pending quick ask. */
export function useQuickAskComposerRequest(
  serverId: string,
  targetId: string,
): { onFinished: () => void } | null {
  const pending = useQuickAskStore(
    (state) => state.pendingByTargetId[targetId]?.serverId === serverId,
  );
  return useMemo(
    () => (pending ? { onFinished: () => useQuickAskStore.getState().finish(targetId) } : null),
    [pending, targetId],
  );
}
