import type { TodoEntry } from "@/types/stream";

/**
 * Daseo delta 101: on wide layouts the right sidebar holds the viewed session's task list, and it
 * opens by itself once when a task list first appears live in the session being viewed. Opening a
 * session that already has a list, switching tabs, reloading, and history pages never open it, and
 * after it opened once for a session the owner's toggle wins.
 */

/** How many sessions remember that the sidebar already opened for them. Oldest are forgotten. */
export const AUTO_OPENED_SESSION_LIMIT = 500;

export function buildTaskSessionKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

/**
 * Whether a live task snapshot is the session's first list: the session had none, and its
 * timeline was already synced, so the empty list was the real state rather than one not loaded
 * yet. History pages never pass through here; only live stream events do.
 */
export function isLiveTaskListFirstAppearance(input: {
  previous: readonly TodoEntry[] | undefined;
  next: readonly TodoEntry[];
  timelineSynced: boolean;
}): boolean {
  if (!input.timelineSynced) return false;
  return (input.previous?.length ?? 0) === 0 && input.next.length > 0;
}

/** What the wide layout shows at one moment. */
export interface TaskSidebarObservation {
  /** The viewed agent session, or null when the viewed tab is not one. */
  sessionKey: string | null;
  /** How many times a task list first appeared live in that session since the app started. */
  liveAppearances: number;
  /** Whether the task sidebar exists here (wide layout, route focused, not focus mode). */
  enabled: boolean;
}

/**
 * Open only on a live first appearance seen while the same session stayed in view. A change of
 * session, a first observation (app start), and a layout that just became wide only set the
 * baseline.
 */
export function shouldAutoOpenTaskSidebar(input: {
  previous: TaskSidebarObservation | null;
  next: TaskSidebarObservation;
  alreadyAutoOpened: boolean;
}): boolean {
  const { previous, next } = input;
  if (!previous || !next.sessionKey || !next.enabled || !previous.enabled) return false;
  if (previous.sessionKey !== next.sessionKey) return false;
  if (next.liveAppearances <= previous.liveAppearances) return false;
  return !input.alreadyAutoOpened;
}

/** The remembered sessions with `sessionKey` added as the newest, capped at `limit`. */
export function rememberAutoOpenedSession(
  sessionKeys: readonly string[],
  sessionKey: string,
  limit: number = AUTO_OPENED_SESSION_LIMIT,
): string[] {
  const next = sessionKeys.filter((key) => key !== sessionKey);
  next.push(sessionKey);
  return next.length > limit ? next.slice(next.length - limit) : next;
}
