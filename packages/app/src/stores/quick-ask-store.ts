import { create } from "zustand";

// Daseo delta 64: a draft tab opened by quick ask starts dictation and auto-sends once. The
// marker lives in memory only, so a restarted app shows the same draft as an ordinary one.
export interface QuickAskDraftRequest {
  serverId: string;
  workspaceId: string;
  draftId: string;
}

interface QuickAskStoreState {
  pendingByDraftId: Record<string, QuickAskDraftRequest>;
  request: (request: QuickAskDraftRequest) => void;
  finish: (draftId: string) => void;
}

export const useQuickAskStore = create<QuickAskStoreState>()((set) => ({
  pendingByDraftId: {},
  request: (request) =>
    set((state) => ({
      pendingByDraftId: { ...state.pendingByDraftId, [request.draftId]: request },
    })),
  finish: (draftId) =>
    set((state) => {
      if (!state.pendingByDraftId[draftId]) {
        return state;
      }
      const { [draftId]: _finished, ...rest } = state.pendingByDraftId;
      return { pendingByDraftId: rest };
    }),
}));
