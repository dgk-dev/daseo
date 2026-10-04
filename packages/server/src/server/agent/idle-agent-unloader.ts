import { execFile } from "node:child_process";
import type { Logger } from "pino";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";

/** Daseo delta 33: default minutes an agent sits unused before its provider process is stopped. */
export const DEFAULT_IDLE_UNLOAD_MINUTES = 60;
const SWEEP_INTERVAL_MS = 60_000;

export type IdleUnloadBlocker =
  | "not_idle"
  | "recently_active"
  | "background_waits"
  | "pending_permission"
  | "not_resumable"
  | "internal"
  | "schedule_target"
  | "orchestrator_running"
  | "child_processes";

export interface IdleAgentUnloaderOptions {
  agentManager: Pick<
    AgentManager,
    "listAgents" | "getAgent" | "getAgentLastActivityAt" | "hasInFlightRun" | "unloadIdleAgent"
  >;
  /** Read on every sweep so a config reload applies without a restart; 0 turns unloading off. */
  getIdleUnloadMinutes: () => number;
  /** Agent ids that an active schedule or heartbeat targets. */
  listScheduleTargetAgentIds: () => Promise<ReadonlySet<string>>;
  /** Child pids of a process; null when the platform cannot tell. */
  listChildProcessIds?: (pid: number) => Promise<number[] | null>;
  now?: () => number;
  sweepIntervalMs?: number;
  logger: Logger;
}

/**
 * Stops the provider process of agents nobody is using, the way Codex's app-server unloads a
 * thread with no subscribers after a quiet period and OpenCode disposes an idle instance. An
 * unloaded agent keeps its stored state, history, and idle status; the next open, prompt, or send
 * resumes it through `ensureAgentLoaded`, the path every agent takes after a daemon restart.
 *
 * An agent is unloaded only when every condition holds: idle with no run, quiet for the
 * configured minutes, no pending background waits (a pi-local `wait_for` lives in the provider
 * process), no pending permission, not the target of an active schedule or heartbeat and not the
 * child of a running orchestrator, and no child processes under its runtime (closing tree-kills
 * them). It must also be resumable: persisted with a session id.
 */
export class IdleAgentUnloader {
  private readonly now: () => number;
  private readonly listChildProcessIds: (pid: number) => Promise<number[] | null>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping: Promise<string[]> | null = null;

  public constructor(private readonly options: IdleAgentUnloaderOptions) {
    this.now = options.now ?? Date.now;
    this.listChildProcessIds = options.listChildProcessIds ?? listChildProcessIds;
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "idle_agent_unloader.sweep_failed");
      });
    }, this.options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Unloads every eligible agent; returns the ids it unloaded. */
  public sweep(): Promise<string[]> {
    this.sweeping ??= this.runSweep().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async runSweep(): Promise<string[]> {
    const idleMs = Math.max(0, this.options.getIdleUnloadMinutes()) * 60_000;
    if (idleMs <= 0) {
      return [];
    }
    const candidates = this.options.agentManager
      .listAgents()
      .filter((agent) => this.quickBlocker(agent, idleMs) === null);
    if (candidates.length === 0) {
      return [];
    }
    const scheduleTargets = await this.options.listScheduleTargetAgentIds();
    const unloaded: string[] = [];
    for (const candidate of candidates) {
      const didUnload = await this.options.agentManager.unloadIdleAgent(
        candidate.id,
        async (agent) => (await this.blocker(agent, idleMs, scheduleTargets)) === null,
      );
      if (didUnload) {
        unloaded.push(candidate.id);
      }
    }
    return unloaded;
  }

  /** The first condition that keeps the agent loaded, or null when it may be unloaded. */
  public async blocker(
    agent: ManagedAgent,
    idleMs: number,
    scheduleTargets: ReadonlySet<string>,
  ): Promise<IdleUnloadBlocker | null> {
    const quick = this.quickBlocker(agent, idleMs);
    if (quick) {
      return quick;
    }
    if (scheduleTargets.has(agent.id)) {
      return "schedule_target";
    }
    const parentId = agent.labels[PARENT_AGENT_ID_LABEL];
    const parent = parentId ? this.options.agentManager.getAgent(parentId) : null;
    if (parent && (parent.lifecycle === "running" || parent.lifecycle === "initializing")) {
      return "orchestrator_running";
    }
    const pid =
      agent.lifecycle === "closed" ? null : (agent.session.getRuntimeProcessId?.() ?? null);
    if (pid !== null) {
      const children = await this.listChildProcessIds(pid);
      if (children === null || children.length > 0) {
        return "child_processes";
      }
    }
    return null;
  }

  private quickBlocker(agent: ManagedAgent, idleMs: number): IdleUnloadBlocker | null {
    if (agent.lifecycle !== "idle" || this.options.agentManager.hasInFlightRun(agent.id)) {
      return "not_idle";
    }
    if (agent.internal) {
      return "internal";
    }
    if (!agent.capabilities.supportsSessionPersistence || !agent.persistence?.sessionId) {
      return "not_resumable";
    }
    if (agent.pendingPermissions.size > 0 || agent.inFlightPermissionResponses.size > 0) {
      return "pending_permission";
    }
    // The raw session count, not the snapshot's: the snapshot drops a wait whose hold expired,
    // but the wait still lives in the provider process until it fires or times out.
    if (
      (agent.session.backgroundWaits?.pending ?? 0) > 0 ||
      (agent.pendingBackgroundWaits ?? 0) > 0
    ) {
      return "background_waits";
    }
    const lastActivityAt = this.options.agentManager.getAgentLastActivityAt(agent.id);
    const quietSince = Math.max(
      lastActivityAt ?? 0,
      agent.updatedAt.getTime(),
      agent.lastUserMessageAt?.getTime() ?? 0,
    );
    if (this.now() - quietSince < idleMs) {
      return "recently_active";
    }
    return null;
  }
}

export function listChildProcessIds(pid: number): Promise<number[] | null> {
  if (process.platform === "win32") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile("pgrep", ["-P", String(pid)], { timeout: 5_000 }, (error, stdout) => {
      const exitCode = (error as { code?: unknown } | null)?.code;
      if (error && exitCode !== 1) {
        // pgrep exits 1 when nothing matches; anything else means the answer is unknown.
        resolve(null);
        return;
      }
      resolve(
        stdout
          .split("\n")
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((child) => Number.isInteger(child) && child > 0),
      );
    });
  });
}
