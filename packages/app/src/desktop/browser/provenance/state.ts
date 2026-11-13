import { z } from "zod";

/**
 * Daseo delta 98: who opened each browser tab and when a person or an agent last used it, and
 * the tabs the auto-close sweep closed. Kept apart from the browser records on purpose: those are
 * validated strictly and an older build deletes the whole store on a field it does not know, so a
 * field added there would cost every tab its URL on a rollback. An older build ignores this store.
 *
 * A tab with no entry here has unknown origin (opened before this build, by a person in the app,
 * or adopted) and is never closed automatically.
 */
export type BrowserOpener = "agent" | "human";

export interface BrowserProvenance {
  openedBy: BrowserOpener;
  /** The agent that opened the tab, when an agent did. */
  creatorAgentId?: string;
  openedAt: number;
  /** The last command any agent sent to this tab, and which agent sent it. */
  lastAgentCommandAt?: number;
  lastAgentId?: string;
  /** When a person last had the tab on screen, on the Mac or the phone, or used it. */
  lastHumanInteractionAt?: number;
  /** A person has seen or used the tab at least once. Such a tab is never closed automatically. */
  humanTouched: boolean;
}

export type BrowserAutoCloseReason = "creator-archived" | "creator-idle";

export interface RecentlyClosedBrowser {
  browserId: string;
  url: string;
  title: string;
  closedAt: number;
  reason: BrowserAutoCloseReason;
}

export interface BrowserProvenanceState {
  provenanceByBrowserId: Record<string, BrowserProvenance>;
  /** The last browser command from each agent, to any tab. */
  agentLastCommandAt: Record<string, number>;
  /** Per workspace persistence key (`serverId:workspaceId`), newest first. */
  recentlyClosedByWorkspace: Record<string, RecentlyClosedBrowser[]>;
}

export const RECENTLY_CLOSED_RETENTION_MS = 14 * 24 * 60 * 60_000;
export const RECENTLY_CLOSED_MAX_PER_WORKSPACE = 50;
/** Agent command times older than this no longer decide anything (the close rule is hours). */
export const AGENT_COMMAND_RETENTION_MS = 30 * 24 * 60 * 60_000;

const BrowserProvenanceSchema = z.object({
  openedBy: z.enum(["agent", "human"]),
  creatorAgentId: z.string().min(1).optional(),
  openedAt: z.number(),
  lastAgentCommandAt: z.number().optional(),
  lastAgentId: z.string().min(1).optional(),
  lastHumanInteractionAt: z.number().optional(),
  humanTouched: z.boolean(),
});

const RecentlyClosedBrowserSchema = z.object({
  browserId: z.string().min(1),
  url: z.string(),
  title: z.string(),
  closedAt: z.number(),
  reason: z.enum(["creator-archived", "creator-idle"]),
});

// Plain objects, not strict: a newer build's extra fields are dropped instead of failing the
// whole store.
export const BrowserProvenanceStateSchema: z.ZodType<BrowserProvenanceState> = z.object({
  provenanceByBrowserId: z.record(z.string(), BrowserProvenanceSchema),
  agentLastCommandAt: z.record(z.string(), z.number()),
  recentlyClosedByWorkspace: z.record(z.string(), z.array(RecentlyClosedBrowserSchema)),
});

export const EMPTY_BROWSER_PROVENANCE_STATE: BrowserProvenanceState = {
  provenanceByBrowserId: {},
  agentLastCommandAt: {},
  recentlyClosedByWorkspace: {},
};

export function normalizeBrowserProvenanceState(value: unknown): BrowserProvenanceState {
  const result = BrowserProvenanceStateSchema.safeParse(value);
  return result.success ? result.data : EMPTY_BROWSER_PROVENANCE_STATE;
}

/** An agent opened the tab: it starts unseen. */
export function recordAgentOpen<S extends BrowserProvenanceState>(
  state: S,
  input: { browserId: string; agentId: string; now: number },
): S {
  return {
    ...state,
    provenanceByBrowserId: {
      ...state.provenanceByBrowserId,
      [input.browserId]: {
        openedBy: "agent",
        creatorAgentId: input.agentId,
        openedAt: input.now,
        lastAgentCommandAt: input.now,
        lastAgentId: input.agentId,
        humanTouched: false,
      },
    },
    agentLastCommandAt: { ...state.agentLastCommandAt, [input.agentId]: input.now },
  };
}

/** A person opened the tab (from the phone, or by reopening a closed one). */
export function recordHumanOpen<S extends BrowserProvenanceState>(
  state: S,
  input: { browserId: string; now: number },
): S {
  return {
    ...state,
    provenanceByBrowserId: {
      ...state.provenanceByBrowserId,
      [input.browserId]: {
        openedBy: "human",
        openedAt: input.now,
        lastHumanInteractionAt: input.now,
        humanTouched: true,
      },
    },
  };
}

/** An agent sent a command; `browserId` is absent for commands that name no tab. */
export function recordAgentCommand<S extends BrowserProvenanceState>(
  state: S,
  input: { browserId?: string; agentId: string; now: number },
): S {
  const existing = input.browserId ? state.provenanceByBrowserId[input.browserId] : undefined;
  return {
    ...state,
    agentLastCommandAt: { ...state.agentLastCommandAt, [input.agentId]: input.now },
    ...(existing && input.browserId
      ? {
          provenanceByBrowserId: {
            ...state.provenanceByBrowserId,
            [input.browserId]: {
              ...existing,
              lastAgentCommandAt: input.now,
              lastAgentId: input.agentId,
            },
          },
        }
      : {}),
  };
}

/**
 * A person had the tab on screen or used it. A tab of unknown origin stays unknown (and so is
 * never closed automatically anyway).
 */
export function recordHumanUse<S extends BrowserProvenanceState>(
  state: S,
  input: { browserId: string; now: number },
): S {
  const existing = state.provenanceByBrowserId[input.browserId];
  if (!existing) {
    return state;
  }
  return {
    ...state,
    provenanceByBrowserId: {
      ...state.provenanceByBrowserId,
      [input.browserId]: {
        ...existing,
        humanTouched: true,
        lastHumanInteractionAt: input.now,
      },
    },
  };
}

export function forgetBrowserProvenance<S extends BrowserProvenanceState>(
  state: S,
  browserId: string,
): S {
  if (!state.provenanceByBrowserId[browserId]) {
    return state;
  }
  const next = { ...state.provenanceByBrowserId };
  delete next[browserId];
  return { ...state, provenanceByBrowserId: next };
}

export function addRecentlyClosedBrowser<S extends BrowserProvenanceState>(
  state: S,
  input: { workspaceKey: string; entry: RecentlyClosedBrowser; now: number },
): S {
  const kept = (state.recentlyClosedByWorkspace[input.workspaceKey] ?? []).filter(
    (entry) =>
      entry.browserId !== input.entry.browserId &&
      input.now - entry.closedAt < RECENTLY_CLOSED_RETENTION_MS,
  );
  return {
    ...state,
    recentlyClosedByWorkspace: {
      ...state.recentlyClosedByWorkspace,
      [input.workspaceKey]: [input.entry, ...kept].slice(0, RECENTLY_CLOSED_MAX_PER_WORKSPACE),
    },
  };
}

export function removeRecentlyClosedBrowser<S extends BrowserProvenanceState>(
  state: S,
  input: { workspaceKey: string; browserId: string },
): S {
  const entries = state.recentlyClosedByWorkspace[input.workspaceKey];
  if (!entries?.some((entry) => entry.browserId === input.browserId)) {
    return state;
  }
  return {
    ...state,
    recentlyClosedByWorkspace: {
      ...state.recentlyClosedByWorkspace,
      [input.workspaceKey]: entries.filter((entry) => entry.browserId !== input.browserId),
    },
  };
}

/** Drops closed tabs older than 14 days and agent command times older than 30. */
export function pruneBrowserProvenance<S extends BrowserProvenanceState>(state: S, now: number): S {
  const recentlyClosedByWorkspace: Record<string, RecentlyClosedBrowser[]> = {};
  let changed = false;
  for (const [workspaceKey, entries] of Object.entries(state.recentlyClosedByWorkspace)) {
    const kept = entries.filter((entry) => now - entry.closedAt < RECENTLY_CLOSED_RETENTION_MS);
    if (kept.length !== entries.length) changed = true;
    if (kept.length > 0) recentlyClosedByWorkspace[workspaceKey] = kept;
    else if (entries.length === 0) changed = true;
  }
  const agentLastCommandAt: Record<string, number> = {};
  for (const [agentId, at] of Object.entries(state.agentLastCommandAt)) {
    if (now - at < AGENT_COMMAND_RETENTION_MS) agentLastCommandAt[agentId] = at;
    else changed = true;
  }
  return changed ? { ...state, recentlyClosedByWorkspace, agentLastCommandAt } : state;
}

/** Agent-opened tabs in `browserIds` that no person has seen, opened by `agentId`. */
export function countUnseenTabsOpenedByAgent(
  state: BrowserProvenanceState,
  input: { agentId: string; browserIds: readonly string[] },
): number {
  return input.browserIds.filter((browserId) => {
    const provenance = state.provenanceByBrowserId[browserId];
    return (
      provenance?.openedBy === "agent" &&
      provenance.creatorAgentId === input.agentId &&
      !provenance.humanTouched
    );
  }).length;
}
