import { useEffect, useRef } from "react";
import { isWeb } from "@/constants/platform";
import { isTaskRailDockedByDefault } from "@/stores/panel-store/state";
import {
  buildTaskSessionKey,
  opensTaskSidebarOnFirstList,
  shouldAutoOpenTaskSidebar,
  type TaskSidebarObservation,
} from "./auto-open";
import { useTaskSidebarStore } from "./store";

/**
 * Opens the task sidebar once when a task list first appears live in the viewed session
 * (Daseo delta 101). `enabled` is false where the pinned sidebar does not exist (focus mode, a
 * workspace not on screen) and on compact layouts, whose overlay would cover the chat. It does
 * nothing where the rail is docked by default.
 */
const OPENS_ON_FIRST_LIST = opensTaskSidebarOnFirstList({
  dockedByDefault: isTaskRailDockedByDefault(isWeb),
});

export function useTaskSidebarAutoOpen(input: {
  serverId: string;
  agentId: string | null;
  enabled: boolean;
  open: () => void;
}): void {
  const { serverId, agentId, open } = input;
  const enabled = input.enabled && OPENS_ON_FIRST_LIST;
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
