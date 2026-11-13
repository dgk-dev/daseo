import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { buildTaskSessionKey, rememberAutoOpenedSession } from "./auto-open";

interface TaskSidebarStoreState {
  /** Live first appearances per session since the app started (not persisted). */
  liveAppearances: Record<string, number>;
  /** Sessions the sidebar already opened for by itself, oldest first (persisted). */
  autoOpenedSessionKeys: string[];
  recordLiveTaskListAppeared: (serverId: string, agentId: string) => void;
  markAutoOpened: (sessionKey: string) => void;
}

const TaskSidebarPersistedStateSchema = z.strictObject({
  autoOpenedSessionKeys: z.array(z.string()),
});

type TaskSidebarPersistedState = z.infer<typeof TaskSidebarPersistedStateSchema>;

// Daseo delta 101: remembers which sessions already opened the task sidebar once, so a reload or
// reconnect does not open it again after the owner closed it.
export const useTaskSidebarStore = create<TaskSidebarStoreState>()(
  persist<TaskSidebarStoreState, [], [], TaskSidebarPersistedState>(
    (set) => ({
      liveAppearances: {},
      autoOpenedSessionKeys: [],
      recordLiveTaskListAppeared: (serverId, agentId) =>
        set((state) => {
          const sessionKey = buildTaskSessionKey(serverId, agentId);
          return {
            liveAppearances: {
              ...state.liveAppearances,
              [sessionKey]: (state.liveAppearances[sessionKey] ?? 0) + 1,
            },
          };
        }),
      markAutoOpened: (sessionKey) =>
        set((state) => ({
          autoOpenedSessionKeys: rememberAutoOpenedSession(state.autoOpenedSessionKeys, sessionKey),
        })),
    }),
    {
      name: "task-sidebar",
      storage: createValidatedPersistStorage(AsyncStorage, TaskSidebarPersistedStateSchema),
      partialize: (state) => ({
        autoOpenedSessionKeys: state.autoOpenedSessionKeys,
      }),
    },
  ),
);
