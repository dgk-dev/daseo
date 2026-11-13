import { useEffect, useRef } from "react";
import {
  buildTaskSessionKey,
  shouldAutoOpenTaskSidebar,
  type TaskSidebarObservation,
} from "./auto-open";
import { useTaskSidebarStore } from "./store";

/**
 * Opens the task sidebar once when a task list first appears live in the viewed session
 * (Daseo delta 101). `enabled` is false where the sidebar does not exist (compact layouts, focus
 * mode, a workspace not on screen).
 */
export function useTaskSidebarAutoOpen(input: {
  serverId: string;
  agentId: string | null;
  enabled: boolean;
  open: () => void;
}): void {
  const { serverId, agentId, enabled, open } = input;
  const sessionKey = serverId && agentId ? buildTaskSessionKey(serverId, agentId) : null;
  const liveAppearances = useTaskSidebarStore((state) =>
    sessionKey ? (state.liveAppearances[sessionKey] ?? 0) : 0,
  );
  const previousRef = useRef<TaskSidebarObservation | null>(null);

  useEffect(() => {
    const next: TaskSidebarObservation = {
      sessionKey,
      liveAppearances,
      enabled,
    };
    const previous = previousRef.current;
    previousRef.current = next;
    const store = useTaskSidebarStore.getState();
    const alreadyAutoOpened =
      sessionKey !== null && store.autoOpenedSessionKeys.includes(sessionKey);
    if (!shouldAutoOpenTaskSidebar({ previous, next, alreadyAutoOpened }) || !sessionKey) return;
    store.markAutoOpened(sessionKey);
    open();
  }, [enabled, liveAppearances, open, sessionKey]);
}
