import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  addRecentlyClosedBrowser,
  BrowserProvenanceStateSchema,
  EMPTY_BROWSER_PROVENANCE_STATE,
  forgetBrowserProvenance,
  normalizeBrowserProvenanceState,
  pruneBrowserProvenance,
  recordAgentCommand,
  recordAgentOpen,
  recordHumanOpen,
  recordHumanUse,
  removeRecentlyClosedBrowser,
  type BrowserProvenanceState,
  type RecentlyClosedBrowser,
} from "./state";

export type {
  BrowserAutoCloseReason,
  BrowserProvenance,
  BrowserProvenanceState,
  RecentlyClosedBrowser,
} from "./state";

interface BrowserProvenanceStore extends BrowserProvenanceState {
  agentOpened: (input: { browserId: string; agentId: string }) => void;
  humanOpened: (input: { browserId: string }) => void;
  agentCommanded: (input: { browserId?: string; agentId: string }) => void;
  humanUsed: (input: { browserId: string }) => void;
  forget: (browserId: string) => void;
  recordClosed: (input: { workspaceKey: string; entry: RecentlyClosedBrowser }) => void;
  takeClosed: (input: { workspaceKey: string; browserId: string }) => RecentlyClosedBrowser | null;
  prune: () => void;
}

/** Daseo delta 98: see ./state.ts. Desktop only in practice: only the Mac hosts browser tabs. */
export const useBrowserProvenanceStore = create<BrowserProvenanceStore>()(
  persist(
    (set, get) => ({
      ...EMPTY_BROWSER_PROVENANCE_STATE,
      agentOpened: (input) => set((state) => recordAgentOpen(state, { ...input, now: Date.now() })),
      humanOpened: (input) => set((state) => recordHumanOpen(state, { ...input, now: Date.now() })),
      agentCommanded: (input) =>
        set((state) => recordAgentCommand(state, { ...input, now: Date.now() })),
      humanUsed: (input) => set((state) => recordHumanUse(state, { ...input, now: Date.now() })),
      forget: (browserId) => set((state) => forgetBrowserProvenance(state, browserId)),
      recordClosed: (input) =>
        set((state) => addRecentlyClosedBrowser(state, { ...input, now: Date.now() })),
      takeClosed: (input) => {
        const entry =
          get().recentlyClosedByWorkspace[input.workspaceKey]?.find(
            (candidate) => candidate.browserId === input.browserId,
          ) ?? null;
        if (entry) set((state) => removeRecentlyClosedBrowser(state, input));
        return entry;
      },
      prune: () => set((state) => pruneBrowserProvenance(state, Date.now())),
    }),
    {
      name: "workspace-browser-provenance",
      storage: createValidatedPersistStorage(AsyncStorage, BrowserProvenanceStateSchema),
      partialize: (state) => ({
        provenanceByBrowserId: state.provenanceByBrowserId,
        agentLastCommandAt: state.agentLastCommandAt,
        recentlyClosedByWorkspace: state.recentlyClosedByWorkspace,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizeBrowserProvenanceState(persistedState),
      }),
    },
  ),
);

const NO_RECENTLY_CLOSED: readonly RecentlyClosedBrowser[] = [];

/** The workspace's recently closed tabs, newest first; one stable empty array when none. */
export function useRecentlyClosedBrowsers(
  workspaceKey: string | null,
): readonly RecentlyClosedBrowser[] {
  return useBrowserProvenanceStore((state) =>
    workspaceKey
      ? (state.recentlyClosedByWorkspace[workspaceKey] ?? NO_RECENTLY_CLOSED)
      : NO_RECENTLY_CLOSED,
  );
}
