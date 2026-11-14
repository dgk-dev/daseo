import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import {
  formatRecoveryNotice,
  RECOVERY_COOLDOWN_MS,
  RESTART_RECOVERY_FILE,
  RestartRecoveryJournal,
} from "./restart-recovery.js";
import { runRestartRecovery } from "./restart-recovery-runner.js";

const logger = pino({ level: "silent" });

function home(): string {
  return mkdtempSync(path.join(tmpdir(), "restart-recovery-"));
}

function waitState(
  agentId: string,
  overrides: Partial<{ pending: number; running: boolean; closed: boolean }> = {},
) {
  return {
    agentId,
    pendingBackgroundWaits: overrides.pending ?? 0,
    backgroundWaitLabels: overrides.pending ? ["web build"] : [],
    running: overrides.running ?? false,
    closed: overrides.closed ?? false,
  };
}

describe("RestartRecoveryJournal", () => {
  test("freeze writes what a shutdown kills and ignores the closes that follow", async () => {
    const paseoHome = home();
    const journal = new RestartRecoveryJournal({ paseoHome, logger });
    journal.addWatcher("child", "parent", true);
    journal.freeze([
      waitState("a", { pending: 1 }),
      waitState("b", { running: true }),
      waitState("c"),
    ]);
    // closeAllAgents runs after freeze: these must not erase the entries.
    journal.noteAgentState(waitState("a", { closed: true }));
    journal.removeWatcher("child", "parent");

    const written = JSON.parse(readFileSync(path.join(paseoHome, RESTART_RECOVERY_FILE), "utf8"));
    expect(written.agents.a.waits).toEqual({ pending: 1, labels: ["web build"] });
    expect(written.agents.b.running).toBe(true);
    expect(written.agents.c).toBeUndefined();
    expect(written.watchers.child).toMatchObject({
      callerAgentId: "parent",
      requireParentOwnership: true,
    });
  });

  test("a settled or purposely closed agent leaves the live journal", async () => {
    const paseoHome = home();
    const journal = new RestartRecoveryJournal({ paseoHome, logger });
    journal.noteAgentState(waitState("a", { pending: 2 }));
    journal.noteAgentState(waitState("b", { running: true }));
    journal.noteAgentState(waitState("a"));
    journal.noteAgentState(waitState("b", { closed: true }));
    await journal.flush();
    const written = JSON.parse(readFileSync(path.join(paseoHome, RESTART_RECOVERY_FILE), "utf8"));
    expect(written.agents).toEqual({});
  });

  test("takePrevious reads the journal once and keeps the cooldown stamps", async () => {
    const paseoHome = home();
    const now = new Date("2026-10-18T12:00:00Z");
    writeFileSync(
      path.join(paseoHome, RESTART_RECOVERY_FILE),
      JSON.stringify({
        version: 1,
        writtenAt: now.toISOString(),
        agents: { a: { waits: { pending: 1, labels: [] }, updatedAt: now.toISOString() } },
        watchers: {},
        recoveredAt: { a: new Date(now.getTime() - 60_000).toISOString() },
      }),
    );
    const journal = new RestartRecoveryJournal({ paseoHome, logger, now: () => now });
    const previous = await journal.takePrevious();
    expect(previous?.agents.a?.waits?.pending).toBe(1);
    expect(existsSync(path.join(paseoHome, RESTART_RECOVERY_FILE))).toBe(false);
    expect(await journal.takePrevious()).toBeNull();
    // Recovered one minute ago: still inside the cooldown.
    expect(journal.claimRecovery("a")).toBe(false);
    expect(journal.claimRecovery("b")).toBe(true);
    expect(journal.claimRecovery("b")).toBe(false);
  });

  test("a watcher's state is updated in place and keeps its first creation time (delta 106)", async () => {
    const paseoHome = home();
    let now = new Date("2026-11-14T01:00:00Z");
    const journal = new RestartRecoveryJournal({ paseoHome, logger, now: () => now });
    journal.addWatcher("child", "parent", true, { finishOwed: true, lastReportHash: null });
    now = new Date("2026-11-14T02:00:00Z");
    journal.addWatcher("child", "parent", true, { finishOwed: false, lastReportHash: "abc" });
    await journal.flush();
    const written = JSON.parse(readFileSync(path.join(paseoHome, RESTART_RECOVERY_FILE), "utf8"));
    expect(written.watchers.child).toEqual({
      callerAgentId: "parent",
      requireParentOwnership: true,
      createdAt: "2026-11-14T01:00:00.000Z",
      finishOwed: false,
      lastReportHash: "abc",
    });
  });

  test("the cooldown expires", () => {
    let clock = new Date("2026-10-18T12:00:00Z");
    const journal = new RestartRecoveryJournal({ paseoHome: home(), logger, now: () => clock });
    expect(journal.claimRecovery("a")).toBe(true);
    clock = new Date(clock.getTime() + RECOVERY_COOLDOWN_MS + 1);
    expect(journal.claimRecovery("a")).toBe(true);
  });
});

describe("formatRecoveryNotice", () => {
  test("names the cause, the lost waits, and asks to verify before re-running", () => {
    const text = formatRecoveryNotice({
      agentId: "a",
      cause: "daemon_restart",
      lostWaits: { pending: 2, labels: ["web build", ""] },
      turnInterrupted: true,
      at: new Date("2026-10-18T02:14:30Z"),
    });
    expect(text).toContain("Daseo restarted at 2026-10-18 11:14 KST");
    expect(text).toContain("Your turn was running and was cut off");
    expect(text).toContain(
      '2 background wait(s) you registered with wait_for were stopped and will never wake you: "web build"',
    );
    expect(text).toContain("before re-running anything");
    expect(text).toContain("[wait noted]");
  });
});

describe("runRestartRecovery", () => {
  function fakes(records: Record<string, Record<string, unknown>>) {
    const prompts: Array<{ agentId: string; prompt: string }> = [];
    const agents = new Map<string, Record<string, unknown>>();
    const agentStorage = {
      get: async (id: string) => (records[id] ? { id, labels: {}, ...records[id] } : null),
    };
    const agentManager = {
      waitForAgentClose: async () => undefined,
      getAgent: (id: string) => agents.get(id),
      getLastAssistantMessage: async () => "done",
      subscribe: () => () => undefined,
    };
    return { prompts, agentStorage, agentManager };
  }

  test("a stale journal wakes nobody", async () => {
    const { agentStorage, agentManager } = fakes({ a: {} });
    const now = new Date("2026-10-18T12:00:00Z");
    const result = await runRestartRecovery({
      journal: new RestartRecoveryJournal({ paseoHome: home(), logger }),
      agentManager: agentManager as never,
      agentStorage: agentStorage as never,
      logger,
      now: () => now,
      previous: {
        version: 1,
        writtenAt: new Date(now.getTime() - 13 * 60 * 60_000).toISOString(),
        agents: { a: { waits: { pending: 1, labels: [] }, updatedAt: now.toISOString() } },
        watchers: {},
        recoveredAt: {},
      },
    });
    expect(result).toMatchObject({ skippedStale: true, notified: [] });
  });

  test("archived agents and archived callers are skipped", async () => {
    const { agentStorage, agentManager } = fakes({
      gone: { archivedAt: "2026-10-18T00:00:00Z" },
      child: {},
      parent: { archivedAt: "2026-10-18T00:00:00Z" },
    });
    const now = new Date("2026-10-18T12:00:00Z");
    const result = await runRestartRecovery({
      journal: new RestartRecoveryJournal({ paseoHome: home(), logger }),
      agentManager: agentManager as never,
      agentStorage: agentStorage as never,
      logger,
      now: () => now,
      previous: {
        version: 1,
        writtenAt: now.toISOString(),
        agents: { gone: { waits: { pending: 1, labels: [] }, updatedAt: now.toISOString() } },
        watchers: {
          child: {
            callerAgentId: "parent",
            requireParentOwnership: true,
            createdAt: now.toISOString(),
          },
        },
        recoveredAt: {},
      },
    });
    expect(result).toMatchObject({ notified: [], rearmed: [], delivered: [] });
  });

  test("a continuing watch with nothing owed is re-armed without loading its child or prompting anyone (delta 106)", async () => {
    const { agentStorage, agentManager, prompts } = fakes({
      child: { labels: { "paseo.parent-agent-id": "parent" } },
      parent: {},
    });
    const now = new Date("2026-11-14T12:00:00Z");
    const result = await runRestartRecovery({
      journal: new RestartRecoveryJournal({ paseoHome: home(), logger }),
      agentManager: agentManager as never,
      agentStorage: agentStorage as never,
      logger,
      now: () => now,
      previous: {
        version: 1,
        writtenAt: now.toISOString(),
        agents: {},
        watchers: {
          child: {
            callerAgentId: "parent",
            requireParentOwnership: true,
            createdAt: now.toISOString(),
            finishOwed: false,
            lastReportHash: "abc",
          },
        },
        recoveredAt: {},
      },
    });
    // The fake manager cannot load an agent: a load attempt would have made this "skipped".
    expect(result).toMatchObject({ notified: [], rearmed: ["child"], delivered: [] });
    expect(prompts).toEqual([]);
  });
});
