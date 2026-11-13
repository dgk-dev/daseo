import { describe, expect, it } from "vitest";
import type { TodoEntry } from "@/types/stream";
import {
  buildTaskSessionKey,
  isLiveTaskListFirstAppearance,
  rememberAutoOpenedSession,
  shouldAutoOpenTaskSidebar,
  type TaskSidebarObservation,
} from "./auto-open";

const TASKS: TodoEntry[] = [
  { text: "Read the plan", completed: false, status: "in_progress" },
  { text: "Ship it", completed: false, status: "pending" },
];

/**
 * Drives the auto-open rule the way the wide workspace screen does: one observation per render of
 * the viewed session, live first appearances counted per session, and the "already opened" memory
 * that survives a reload.
 */
function createHarness(initialAutoOpened: string[] = []) {
  const liveAppearances = new Map<string, number>();
  let autoOpened = [...initialAutoOpened];
  let previous: TaskSidebarObservation | null = null;
  let opens = 0;

  function observe(view: { serverId: string; agentId: string | null; enabled?: boolean }) {
    const sessionKey = view.agentId ? buildTaskSessionKey(view.serverId, view.agentId) : null;
    const next: TaskSidebarObservation = {
      sessionKey,
      liveAppearances: sessionKey ? (liveAppearances.get(sessionKey) ?? 0) : 0,
      enabled: view.enabled ?? true,
    };
    const shouldOpen = shouldAutoOpenTaskSidebar({
      previous,
      next,
      alreadyAutoOpened: sessionKey !== null && autoOpened.includes(sessionKey),
    });
    previous = next;
    if (shouldOpen && sessionKey) {
      autoOpened = rememberAutoOpenedSession(autoOpened, sessionKey);
      opens += 1;
    }
  }

  /** A live todo event; counted only when it is the session's first list. */
  function liveTaskSnapshot(input: {
    serverId: string;
    agentId: string;
    previous: TodoEntry[] | undefined;
    next: TodoEntry[];
    timelineSynced?: boolean;
  }) {
    if (
      !isLiveTaskListFirstAppearance({
        previous: input.previous,
        next: input.next,
        timelineSynced: input.timelineSynced ?? true,
      })
    ) {
      return;
    }
    const key = buildTaskSessionKey(input.serverId, input.agentId);
    liveAppearances.set(key, (liveAppearances.get(key) ?? 0) + 1);
  }

  return {
    observe,
    liveTaskSnapshot,
    get opens() {
      return opens;
    },
    get autoOpened() {
      return autoOpened;
    },
  };
}

describe("task sidebar auto-open (Daseo delta 101)", () => {
  it("opens once when the first list appears live in the viewed session", () => {
    const harness = createHarness();
    harness.observe({ serverId: "s", agentId: "a" });
    harness.liveTaskSnapshot({
      serverId: "s",
      agentId: "a",
      previous: undefined,
      next: TASKS,
    });
    harness.observe({ serverId: "s", agentId: "a" });
    expect(harness.opens).toBe(1);

    harness.observe({ serverId: "s", agentId: "a" });
    expect(harness.opens).toBe(1);
  });

  it("does not reopen after the owner closed it, on later updates or a cleared and refilled list", () => {
    const harness = createHarness();
    harness.observe({ serverId: "s", agentId: "a" });
    harness.liveTaskSnapshot({
      serverId: "s",
      agentId: "a",
      previous: undefined,
      next: TASKS,
    });
    harness.observe({ serverId: "s", agentId: "a" });
    expect(harness.opens).toBe(1);

    // He closes it; the agent keeps updating the list.
    const updated = [{ ...TASKS[0]!, status: "completed" as const, completed: true }, TASKS[1]!];
    harness.liveTaskSnapshot({
      serverId: "s",
      agentId: "a",
      previous: TASKS,
      next: updated,
    });
    harness.observe({ serverId: "s", agentId: "a" });
    // The agent clears the list and starts a new one.
    harness.liveTaskSnapshot({
      serverId: "s",
      agentId: "a",
      previous: [],
      next: TASKS,
    });
    harness.observe({ serverId: "s", agentId: "a" });
    expect(harness.opens).toBe(1);
  });

  it("does not open for a list that appears in a session not being viewed, nor on switching to it", () => {
    const harness = createHarness();
    harness.observe({ serverId: "s", agentId: "viewed" });
    harness.liveTaskSnapshot({
      serverId: "s",
      agentId: "other",
      previous: undefined,
      next: TASKS,
    });
    harness.observe({ serverId: "s", agentId: "viewed" });
    harness.observe({ serverId: "s", agentId: "other" });
    expect(harness.opens).toBe(0);
  });

  it("does not open when reopening or reloading a session that already has a list", () => {
    // Reload: the first observation after start only sets the baseline, even with an appearance.
    const reloaded = createHarness();
    reloaded.liveTaskSnapshot({
      serverId: "s",
      agentId: "a",
      previous: undefined,
      next: TASKS,
    });
    reloaded.observe({ serverId: "s", agentId: "a" });
    expect(reloaded.opens).toBe(0);

    // Reopen: switching back to a session whose list is already there.
    const reopened = createHarness();
    reopened.observe({ serverId: "s", agentId: "b" });
    reopened.observe({ serverId: "s", agentId: "a" });
    expect(reopened.opens).toBe(0);

    // A session that opened the sidebar before the reload stays remembered.
    const remembered = createHarness([buildTaskSessionKey("s", "a")]);
    remembered.observe({ serverId: "s", agentId: "a" });
    remembered.liveTaskSnapshot({
      serverId: "s",
      agentId: "a",
      previous: [],
      next: TASKS,
    });
    remembered.observe({ serverId: "s", agentId: "a" });
    expect(remembered.opens).toBe(0);
  });

  it("does not open on history replay: a list loaded with the timeline is not a live appearance", () => {
    const harness = createHarness();
    harness.observe({ serverId: "s", agentId: "a" });
    // The timeline was not synced yet when the list arrived.
    harness.liveTaskSnapshot({
      serverId: "s",
      agentId: "a",
      previous: undefined,
      next: TASKS,
      timelineSynced: false,
    });
    harness.observe({ serverId: "s", agentId: "a" });
    expect(harness.opens).toBe(0);
    expect(
      isLiveTaskListFirstAppearance({
        previous: undefined,
        next: TASKS,
        timelineSynced: false,
      }),
    ).toBe(false);
  });

  it("does not open where the sidebar does not exist, nor when the layout becomes wide later", () => {
    const harness = createHarness();
    harness.observe({ serverId: "s", agentId: "a", enabled: false });
    harness.liveTaskSnapshot({
      serverId: "s",
      agentId: "a",
      previous: undefined,
      next: TASKS,
    });
    harness.observe({ serverId: "s", agentId: "a", enabled: false });
    harness.observe({ serverId: "s", agentId: "a", enabled: true });
    expect(harness.opens).toBe(0);
  });

  it("keeps the remembered sessions bounded, newest last", () => {
    expect(rememberAutoOpenedSession(["a", "b", "c"], "b", 3)).toEqual(["a", "c", "b"]);
    expect(rememberAutoOpenedSession(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });
});
