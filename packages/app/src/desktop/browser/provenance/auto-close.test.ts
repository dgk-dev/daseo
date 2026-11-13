import { describe, expect, test } from "vitest";
import { decideBrowserAutoClose, type CreatorAgentStatus } from "./auto-close";
import {
  addRecentlyClosedBrowser,
  countUnseenTabsOpenedByAgent,
  EMPTY_BROWSER_PROVENANCE_STATE,
  normalizeBrowserProvenanceState,
  pruneBrowserProvenance,
  recordAgentCommand,
  recordAgentOpen,
  recordHumanOpen,
  recordHumanUse,
  RECENTLY_CLOSED_RETENTION_MS,
  type BrowserProvenanceState,
} from "./state";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000;
const AFTER = 24 * HOUR;
const IDLE: CreatorAgentStatus = { kind: "active", running: false };

function opened(by = "agent-a", browserId = "tab-1"): BrowserProvenanceState {
  return recordAgentOpen(EMPTY_BROWSER_PROVENANCE_STATE, { browserId, agentId: by, now: T0 });
}

function decide(
  state: BrowserProvenanceState,
  creator: CreatorAgentStatus,
  now: number,
  focusedInPane = false,
) {
  return decideBrowserAutoClose({
    state,
    tab: { browserId: "tab-1", focusedInPane },
    creator,
    now,
    afterMs: AFTER,
  });
}

describe("agent tab auto-close rule (delta 98)", () => {
  test("closes an unseen agent tab once its creator is archived", () => {
    expect(decide(opened(), { kind: "archived" }, T0 + HOUR)).toEqual({
      close: true,
      reason: "creator-archived",
      idleHours: 1,
    });
  });

  test("closes it 24 hours after the creator's last browser command, not before", () => {
    const state = recordAgentCommand(opened(), { agentId: "agent-a", now: T0 + 5 * HOUR });
    expect(decide(state, IDLE, T0 + 5 * HOUR + AFTER - 1)).toEqual({
      close: false,
      keep: "creator-recent",
    });
    expect(decide(state, IDLE, T0 + 5 * HOUR + AFTER)).toEqual({
      close: true,
      reason: "creator-idle",
      idleHours: 24,
    });
  });

  test("a creator that is running or waiting is never idle, however long ago it used the browser", () => {
    expect(decide(opened(), { kind: "active", running: true }, T0 + 3 * DAY)).toEqual({
      close: false,
      keep: "creator-running",
    });
  });

  test("a creator the daemon could not be asked about keeps the tab", () => {
    expect(decide(opened(), { kind: "unknown" }, T0 + 30 * DAY)).toEqual({
      close: false,
      keep: "creator-unknown",
    });
  });

  test("a tab a person ever had on screen or used is kept for good", () => {
    const seen = recordHumanUse(opened(), { browserId: "tab-1", now: T0 + 1 });
    expect(decide(seen, { kind: "archived" }, T0 + 30 * DAY)).toEqual({
      close: false,
      keep: "seen-by-person",
    });
  });

  test("tabs of unknown origin or opened by a person are kept", () => {
    expect(decide(EMPTY_BROWSER_PROVENANCE_STATE, { kind: "archived" }, T0 + DAY * 30)).toEqual({
      close: false,
      keep: "unknown-origin",
    });
    const human = recordHumanOpen(EMPTY_BROWSER_PROVENANCE_STATE, { browserId: "tab-1", now: T0 });
    expect(decide(human, { kind: "archived" }, T0 + DAY * 30)).toEqual({
      close: false,
      keep: "opened-by-person",
    });
  });

  test("the selected tab of a pane is kept", () => {
    expect(decide(opened(), { kind: "archived" }, T0 + DAY, true)).toEqual({
      close: false,
      keep: "focused-in-pane",
    });
  });

  test("a tab another agent used within the idle time is kept even when its creator is archived", () => {
    const state = recordAgentCommand(opened(), {
      browserId: "tab-1",
      agentId: "agent-b",
      now: T0 + 2 * HOUR,
    });
    expect(decide(state, { kind: "archived" }, T0 + 3 * HOUR)).toEqual({
      close: false,
      keep: "used-by-another-agent",
    });
    expect(decide(state, { kind: "archived" }, T0 + 2 * HOUR + AFTER)).toMatchObject({
      close: true,
    });
  });

  test("a creator the daemon no longer knows can only close by idle time", () => {
    expect(decide(opened(), { kind: "missing" }, T0 + HOUR)).toEqual({
      close: false,
      keep: "creator-recent",
    });
    expect(decide(opened(), { kind: "missing" }, T0 + AFTER)).toMatchObject({ close: true });
  });
});

describe("browser provenance state (delta 98)", () => {
  test("a command without a tab still counts as the agent's last browser use", () => {
    const state = recordAgentCommand(opened(), { agentId: "agent-a", now: T0 + 9 });
    expect(state.agentLastCommandAt).toEqual({ "agent-a": T0 + 9 });
    expect(state.provenanceByBrowserId["tab-1"]?.lastAgentCommandAt).toBe(T0);
  });

  test("human use of a tab of unknown origin leaves it unknown", () => {
    expect(recordHumanUse(EMPTY_BROWSER_PROVENANCE_STATE, { browserId: "x", now: T0 })).toBe(
      EMPTY_BROWSER_PROVENANCE_STATE,
    );
  });

  test("recently closed keeps newest first, one entry per tab, and drops entries after 14 days", () => {
    const entry = (browserId: string, closedAt: number) => ({
      browserId,
      url: `https://${browserId}.test/`,
      title: browserId,
      closedAt,
      reason: "creator-idle" as const,
    });
    let state = addRecentlyClosedBrowser(EMPTY_BROWSER_PROVENANCE_STATE, {
      workspaceKey: "s:w",
      entry: entry("a", T0),
      now: T0,
    });
    state = addRecentlyClosedBrowser(state, {
      workspaceKey: "s:w",
      entry: entry("b", T0 + 1),
      now: T0 + 1,
    });
    state = addRecentlyClosedBrowser(state, {
      workspaceKey: "s:w",
      entry: entry("a", T0 + 2),
      now: T0 + 2,
    });
    expect(state.recentlyClosedByWorkspace["s:w"]?.map((e) => e.browserId)).toEqual(["a", "b"]);

    const pruned = pruneBrowserProvenance(state, T0 + 1 + RECENTLY_CLOSED_RETENTION_MS);
    expect(pruned.recentlyClosedByWorkspace["s:w"]?.map((e) => e.browserId)).toEqual(["a"]);
    expect(pruneBrowserProvenance(pruned, T0 + 3 + RECENTLY_CLOSED_RETENTION_MS)).toEqual({
      ...pruned,
      recentlyClosedByWorkspace: {},
      agentLastCommandAt: {},
    });
  });

  test("counts only the agent's own tabs that no person has seen", () => {
    let state = opened("agent-a", "t1");
    state = recordAgentOpen(state, { browserId: "t2", agentId: "agent-a", now: T0 });
    state = recordAgentOpen(state, { browserId: "t3", agentId: "agent-b", now: T0 });
    state = recordHumanUse(state, { browserId: "t2", now: T0 });
    expect(
      countUnseenTabsOpenedByAgent(state, { agentId: "agent-a", browserIds: ["t1", "t2", "t3"] }),
    ).toBe(1);
  });

  test("a stored state from a newer build keeps what it can read; a broken one starts empty", () => {
    const stored = {
      ...opened(),
      futureField: true,
    };
    expect(normalizeBrowserProvenanceState(stored)).toEqual(opened());
    expect(normalizeBrowserProvenanceState({ provenanceByBrowserId: 7 })).toEqual(
      EMPTY_BROWSER_PROVENANCE_STATE,
    );
  });
});
