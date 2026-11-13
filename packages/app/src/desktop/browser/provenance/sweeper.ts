import type { DesktopBrowserAutoCloseLogEntry, DesktopHostBridge } from "@/desktop/host";
import { getBrowserRecord, useBrowserStore } from "@/desktop/browser/store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  collectAllPanes,
  collectAllTabs,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { useBrowserProvenanceStore } from "./index";
import {
  decideBrowserAutoClose,
  type BrowserAutoCloseDecision,
  type CreatorAgentStatus,
} from "./auto-close";

/** How often the sweep runs, and how soon after the app connects to a daemon. */
export const BROWSER_AUTO_CLOSE_SWEEP_MS = 10 * 60_000;
export const BROWSER_AUTO_CLOSE_FIRST_SWEEP_MS = 2 * 60_000;
/** A rehearsal `would close` line repeats at most this often per tab. */
export const BROWSER_AUTO_CLOSE_REHEARSAL_LOG_MS = 24 * 60 * 60_000;
const CREATOR_LOOKUP_TIMEOUT_MS = 10_000;

/** The agent fields the sweep reads from the daemon. */
export interface BrowserAutoCloseCreatorSnapshot {
  status: string;
  archivedAt?: string | null;
  backgroundWaits?: { pending: number };
}

export interface BrowserAutoCloseSweepPorts {
  serverId: string;
  /** Null when the daemon has no such agent; throws when it could not be asked. */
  fetchAgent(agentId: string): Promise<BrowserAutoCloseCreatorSnapshot | null>;
  getBrowserHost(): DesktopHostBridge["browser"] | undefined;
  /** Closes one tab the way browser_close_tab does. */
  closeTab(input: { workspaceKey: string; tabId: string; browserId: string }): Promise<void>;
  now?: () => number;
}

interface SweepCandidate {
  workspaceKey: string;
  workspaceId: string;
  tabId: string;
  browserId: string;
  creatorAgentId: string;
  decision: Extract<BrowserAutoCloseDecision, { close: true }>;
}

export interface BrowserAutoCloseSweepResult {
  mode: "off" | "rehearse" | "on" | "skipped";
  wouldClose: string[];
  closed: string[];
}

export function creatorStatusFromSnapshot(
  snapshot: BrowserAutoCloseCreatorSnapshot | null,
): CreatorAgentStatus {
  if (!snapshot) return { kind: "missing" };
  if (snapshot.archivedAt) return { kind: "archived" };
  const running =
    snapshot.status === "running" ||
    snapshot.status === "initializing" ||
    (snapshot.backgroundWaits?.pending ?? 0) > 0;
  return { kind: "active", running };
}

/**
 * Daseo delta 98: one pass of the agent-tab auto-close over this daemon's workspaces. Reads
 * provenance and layouts here, asks the daemon about each creator agent and main about live
 * state, then logs (`rehearse`) or closes (`on`) what is due. Anything that cannot be read keeps
 * its tab. Every tab it closes is re-checked right before closing and goes to the workspace's
 * recently closed list.
 */
export class BrowserAutoCloseSweeper {
  private readonly now: () => number;
  private readonly rehearsalLoggedAt = new Map<string, number>();
  private running = false;

  public constructor(private readonly ports: BrowserAutoCloseSweepPorts) {
    this.now = ports.now ?? Date.now;
  }

  public async sweep(): Promise<BrowserAutoCloseSweepResult> {
    const skipped: BrowserAutoCloseSweepResult = { mode: "skipped", wouldClose: [], closed: [] };
    const browserHost = this.ports.getBrowserHost();
    if (
      this.running ||
      !browserHost?.autoCloseCheck ||
      !useWorkspaceLayoutStore.persist.hasHydrated() ||
      !useBrowserStore.persist.hasHydrated() ||
      !useBrowserProvenanceStore.persist.hasHydrated()
    ) {
      return skipped;
    }
    this.running = true;
    try {
      useBrowserProvenanceStore.getState().prune();
      const policy = await browserHost.autoCloseCheck([]);
      if (!policy || policy.mode === "off") {
        return { ...skipped, mode: policy ? "off" : "skipped" };
      }
      const afterMs = policy.afterHours * 3_600_000;
      const candidates = await this.findCandidates(afterMs);
      if (candidates.length === 0) {
        return { mode: policy.mode, wouldClose: [], closed: [] };
      }
      const check = await browserHost.autoCloseCheck(candidates.map((c) => c.browserId));
      if (!check || check.mode === "off") {
        return { ...skipped, mode: check ? "off" : "skipped" };
      }
      const due = candidates.filter((candidate) => check.blockers[candidate.browserId] === null);
      if (check.mode === "rehearse") {
        return { mode: "rehearse", wouldClose: await this.logRehearsal(due), closed: [] };
      }
      return { mode: "on", wouldClose: [], closed: await this.closeDue(due, afterMs) };
    } catch (error) {
      console.warn("[browser-auto-close] sweep failed; nothing closed", error);
      return skipped;
    } finally {
      this.running = false;
    }
  }

  private async findCandidates(afterMs: number): Promise<SweepCandidate[]> {
    const pending: Array<Omit<SweepCandidate, "decision">> = [];
    const provenance = useBrowserProvenanceStore.getState();
    const layouts = useWorkspaceLayoutStore.getState().layoutByWorkspace;
    const prefix = `${this.ports.serverId}:`;
    for (const [workspaceKey, layout] of Object.entries(layouts)) {
      if (!workspaceKey.startsWith(prefix)) continue;
      const workspaceId = workspaceKey.slice(prefix.length);
      const selected = selectedTabIds(layout);
      for (const tab of collectAllTabs(layout.root)) {
        if (tab.target.kind !== "browser" || selected.has(tab.tabId)) continue;
        const record = provenance.provenanceByBrowserId[tab.target.browserId];
        if (record?.openedBy !== "agent" || !record.creatorAgentId || record.humanTouched) {
          continue;
        }
        pending.push({
          workspaceKey,
          workspaceId,
          tabId: tab.tabId,
          browserId: tab.target.browserId,
          creatorAgentId: record.creatorAgentId,
        });
      }
    }
    const creators = await this.lookUpCreators(new Set(pending.map((c) => c.creatorAgentId)));
    const now = this.now();
    return pending.flatMap((candidate): SweepCandidate[] => {
      const decision = decideBrowserAutoClose({
        state: useBrowserProvenanceStore.getState(),
        tab: { browserId: candidate.browserId, focusedInPane: false },
        creator: creators.get(candidate.creatorAgentId) ?? { kind: "unknown" },
        now,
        afterMs,
      });
      return decision.close ? [{ ...candidate, decision }] : [];
    });
  }

  private async lookUpCreators(agentIds: Set<string>): Promise<Map<string, CreatorAgentStatus>> {
    const statuses = new Map<string, CreatorAgentStatus>();
    for (const agentId of agentIds) {
      try {
        statuses.set(
          agentId,
          creatorStatusFromSnapshot(
            await withTimeout(this.ports.fetchAgent(agentId), CREATOR_LOOKUP_TIMEOUT_MS),
          ),
        );
      } catch {
        statuses.set(agentId, { kind: "unknown" });
      }
    }
    return statuses;
  }

  private async logRehearsal(due: SweepCandidate[]): Promise<string[]> {
    const now = this.now();
    const fresh = due.filter(
      (candidate) =>
        now - (this.rehearsalLoggedAt.get(candidate.browserId) ?? -Infinity) >=
        BROWSER_AUTO_CLOSE_REHEARSAL_LOG_MS,
    );
    for (const candidate of fresh) this.rehearsalLoggedAt.set(candidate.browserId, now);
    if (fresh.length > 0) {
      await this.ports
        .getBrowserHost()
        ?.recordAutoClose?.(fresh.map((candidate) => logEntry("would-close", candidate)));
    }
    return due.map((candidate) => candidate.browserId);
  }

  private async closeDue(due: SweepCandidate[], afterMs: number): Promise<string[]> {
    const closed: string[] = [];
    const browserHost = this.ports.getBrowserHost();
    for (const candidate of due) {
      // Re-checked one at a time right before closing: a person may have shown or used the tab,
      // or an agent may have commanded it, since the sweep started.
      if (!this.stillDue(candidate, afterMs)) continue;
      const live = await browserHost?.autoCloseCheck?.([candidate.browserId]);
      if (!live || live.mode !== "on" || live.blockers[candidate.browserId] !== null) continue;
      if (!this.stillDue(candidate, afterMs)) continue;
      const record = getBrowserRecord(candidate.browserId);
      await this.ports.closeTab(candidate);
      useBrowserProvenanceStore.getState().recordClosed({
        workspaceKey: candidate.workspaceKey,
        entry: {
          browserId: candidate.browserId,
          url: record?.url ?? "",
          title: record?.title ?? "",
          closedAt: this.now(),
          reason: candidate.decision.reason,
        },
      });
      await browserHost?.recordAutoClose?.([logEntry("closed", candidate, record?.url)]);
      closed.push(candidate.browserId);
    }
    return closed;
  }

  private stillDue(candidate: SweepCandidate, afterMs: number): boolean {
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[candidate.workspaceKey];
    const stillOpen =
      layout !== undefined &&
      collectAllTabs(layout.root).some(
        (tab) =>
          tab.tabId === candidate.tabId &&
          tab.target.kind === "browser" &&
          tab.target.browserId === candidate.browserId,
      );
    if (!layout || !stillOpen) return false;
    const decision = decideBrowserAutoClose({
      state: useBrowserProvenanceStore.getState(),
      tab: {
        browserId: candidate.browserId,
        focusedInPane: selectedTabIds(layout).has(candidate.tabId),
      },
      // The creator was looked up moments ago; an archived one stays archived.
      creator:
        candidate.decision.reason === "creator-archived"
          ? { kind: "archived" }
          : { kind: "active", running: false },
      now: this.now(),
      afterMs,
    });
    return decision.close;
  }
}

/** The selected tab of every pane: any of them may be on screen. */
function selectedTabIds(layout: WorkspaceLayout): Set<string> {
  return new Set(
    collectAllPanes(layout.root).flatMap((pane) => (pane.focusedTabId ? [pane.focusedTabId] : [])),
  );
}

function logEntry(
  action: DesktopBrowserAutoCloseLogEntry["action"],
  candidate: SweepCandidate,
  url = getBrowserRecord(candidate.browserId)?.url,
): DesktopBrowserAutoCloseLogEntry {
  return {
    action,
    browserId: candidate.browserId,
    workspaceId: candidate.workspaceId,
    reason: candidate.decision.reason,
    creatorAgentId: candidate.creatorAgentId,
    idleHours: candidate.decision.idleHours,
    host: hostOf(url),
  };
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs the sweep two minutes after mount and then every ten minutes until unmounted. Main may
 * shorten both for an E2E run (`sweepIntervalMs`).
 */
export function mountBrowserAutoCloseSweeper(ports: BrowserAutoCloseSweepPorts): () => void {
  const sweeper = new BrowserAutoCloseSweeper(ports);
  let stopped = false;
  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  const run = () => {
    void sweeper.sweep();
  };
  const schedule = (overrideMs: number | undefined) => {
    if (stopped) return;
    first = setTimeout(run, overrideMs ?? BROWSER_AUTO_CLOSE_FIRST_SWEEP_MS);
    interval = setInterval(run, overrideMs ?? BROWSER_AUTO_CLOSE_SWEEP_MS);
  };
  void Promise.resolve(ports.getBrowserHost()?.autoCloseCheck?.([]))
    .then((policy) => schedule(policy?.sweepIntervalMs))
    .catch(() => schedule(undefined));
  return () => {
    stopped = true;
    if (first) clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
