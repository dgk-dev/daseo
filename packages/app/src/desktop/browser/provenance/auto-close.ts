import type { BrowserAutoCloseReason, BrowserProvenanceState } from "./state";

/**
 * What the daemon says about the agent that opened a tab. `missing`: the daemon has no record of
 * it (deleted), so it cannot be running. `unknown`: the daemon could not be asked; nothing closes.
 */
export type CreatorAgentStatus =
  | { kind: "archived" }
  | { kind: "active"; running: boolean }
  | { kind: "missing" }
  | { kind: "unknown" };

/** Why a tab stays open. The first five are read in the app; the rest come from main. */
export type BrowserAutoCloseKeepReason =
  | "unknown-origin"
  | "opened-by-person"
  | "seen-by-person"
  | "focused-in-pane"
  | "used-by-another-agent"
  | "creator-running"
  | "creator-unknown"
  | "creator-recent"
  | "main-blocked";

export type BrowserAutoCloseDecision =
  | { close: true; reason: BrowserAutoCloseReason; idleHours: number }
  | { close: false; keep: BrowserAutoCloseKeepReason };

export interface BrowserAutoCloseTab {
  browserId: string;
  /** The tab is the selected tab of a pane, so a person may have it on screen. */
  focusedInPane: boolean;
}

/**
 * The provenance part of the auto-close rule. A tab closes only when an agent opened it, no person
 * has ever seen or used it, it is not the selected tab of any pane, no other agent used it within
 * the idle time, and its creator is archived or has sent no browser command for `afterMs` and is
 * not running. Anything not known keeps the tab. Main still has to clear it (on screen, phone
 * stream, typed into, downloading, audible, dialog, popup) before it is closed.
 */
export function decideBrowserAutoClose(input: {
  state: BrowserProvenanceState;
  tab: BrowserAutoCloseTab;
  creator: CreatorAgentStatus;
  now: number;
  afterMs: number;
}): BrowserAutoCloseDecision {
  const { state, tab, creator, now, afterMs } = input;
  const provenance = state.provenanceByBrowserId[tab.browserId];
  const tabKeep = keepReasonForTab(provenance, tab, now, afterMs);
  if (tabKeep || !provenance?.creatorAgentId) {
    return { close: false, keep: tabKeep ?? "unknown-origin" };
  }
  const creatorId = provenance.creatorAgentId;
  const lastCreatorUse = Math.max(
    provenance.openedAt,
    provenance.lastAgentId === creatorId ? (provenance.lastAgentCommandAt ?? 0) : 0,
    state.agentLastCommandAt[creatorId] ?? 0,
  );
  const idleHours = Math.max(0, Math.floor((now - lastCreatorUse) / 3_600_000));
  if (creator.kind === "unknown") {
    return { close: false, keep: "creator-unknown" };
  }
  if (creator.kind === "archived") {
    return { close: true, reason: "creator-archived", idleHours };
  }
  if (creator.kind === "active" && creator.running) {
    return { close: false, keep: "creator-running" };
  }
  return now - lastCreatorUse >= afterMs
    ? { close: true, reason: "creator-idle", idleHours }
    : { close: false, keep: "creator-recent" };
}

/** What about the tab itself keeps it, before its creator is considered. */
function keepReasonForTab(
  provenance: BrowserProvenanceState["provenanceByBrowserId"][string] | undefined,
  tab: BrowserAutoCloseTab,
  now: number,
  afterMs: number,
): BrowserAutoCloseKeepReason | null {
  if (!provenance || (provenance.openedBy === "agent" && !provenance.creatorAgentId)) {
    return "unknown-origin";
  }
  if (provenance.openedBy !== "agent") return "opened-by-person";
  if (provenance.humanTouched || provenance.lastHumanInteractionAt !== undefined) {
    return "seen-by-person";
  }
  if (tab.focusedInPane) return "focused-in-pane";
  const usedByAnotherAgent =
    provenance.lastAgentId !== undefined &&
    provenance.lastAgentId !== provenance.creatorAgentId &&
    provenance.lastAgentCommandAt !== undefined &&
    now - provenance.lastAgentCommandAt < afterMs;
  return usedByAnotherAgent ? "used-by-another-agent" : null;
}
