import { describe, expect, it, test, vi } from "vitest";
import pino, { type Logger } from "pino";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  ARCHIVE_ON_FINISH_LABEL,
  archiveAfterFirstTurn,
  callerReadsNextTurn,
  FINISH_WATCH_STALL_CHECK_MS,
  FINISH_WATCH_STALL_MS,
  finishReportHash,
  type FinishWatchState,
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  sendPromptToAgent,
  setFinishWatcherJournal,
  setupFinishNotification,
  SUB_AGENT_HOLD_MAX_MS,
} from "./agent-prompt.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";

interface CapturedLogger {
  logger: Logger;
  records: Array<Record<string, unknown>>;
  nextRecord: Promise<void>;
}

function createCapturedLogger(): CapturedLogger {
  const records: Array<Record<string, unknown>> = [];
  let resolveNextRecord!: () => void;
  const nextRecord = new Promise<void>((resolve) => {
    resolveNextRecord = resolve;
  });
  const logger = pino(
    { level: "error" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
        resolveNextRecord();
      },
    },
  );
  return { logger, records, nextRecord };
}

interface FinishNotificationScenarioOptions {
  childLastAssistantMessage?: string | null;
  childParentAgentId?: string | null;
  requireParentOwnership?: boolean;
  parentPromptError?: Error;
  logger?: Logger;
  childArchivesOnFinish?: boolean;
  callerArchived?: boolean;
  /** The first this many parent prompts throw, like a provider that rejects the run. */
  parentPromptFailures?: number;
}

interface FinishNotificationScenario {
  startWatchingChild(): void;
  /** Re-arm the watch the way restart recovery does from a journal entry. */
  resumeWatchingChild(state: FinishWatchState): void;
  /** send_agent_prompt with background false or notifyOnFinish false. */
  promptChildWithoutNotice(): void;
  archiveChildAfterFirstTurn(): void;
  unarchiveChild(): void;
  /** Parent prompts and child archives, in the order they happened. */
  events(): string[];
  setChildLastAssistantMessage(message: string | null): void;
  requestChildPermission(requestId?: string): void;
  resolveChildPermission(requestId?: string): void;
  resolveChildPermissionFromState(requestId?: string): void;
  resolveChildPermissionWhileIdle(requestId?: string): void;
  finishChild(pendingBackgroundWaits?: number): void;
  finishChildAndReadParentPrompt(): Promise<string>;
  closeChildAndReadParentPrompt(): Promise<string>;
  failChild(): void;
  runChild(): void;
  emitChildProgress(): void;
  parentPrompts(): string[];
  wasParentPrompted(): boolean;
}

function createFinishNotificationScenario(
  options?: FinishNotificationScenarioOptions,
): FinishNotificationScenario {
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const subscriber = {
    emit(event: AgentManagerEvent) {
      for (const callback of subscribers) callback(event);
    },
  };
  let lastAssistantMessage = options?.childLastAssistantMessage ?? null;
  let resolveParentPrompt: ((prompt: string) => void) | null = null;
  let parentPrompted = false;
  const parentPrompts: string[] = [];
  const events: string[] = [];
  let childArchivedAt: string | null = null;
  let parentPromptFailures = options?.parentPromptFailures ?? 0;
  const childLabels: Record<string, string> = options?.childArchivesOnFinish
    ? { [ARCHIVE_ON_FINISH_LABEL]: "true" }
    : {};

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });
  Reflect.set(childAgent, "pendingPermissions", new Map());
  Reflect.set(childAgent, "labels", childLabels);

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(agentManager, "getAgent", (agentId: string) => {
    if (agentId === "child-agent") {
      return childAgent;
    }
    if (agentId === "caller-agent") {
      return callerAgent;
    }
    return null;
  });
  Reflect.set(agentManager, "subscribe", (callback: (event: AgentManagerEvent) => void) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  // Like the real manager, an archived child's last message is no longer readable here.
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    return childArchivedAt ? null : lastAssistantMessage;
  });
  Reflect.set(agentManager, "clearAgentAttention", async () => undefined);
  Reflect.set(agentManager, "archiveAgent", async (agentId: string) => {
    childArchivedAt = "2026-11-13T00:00:00.000Z";
    events.push(`archive ${agentId}`);
    return { archivedAt: childArchivedAt };
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "trySteerAgentRun", async () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => Boolean(options?.parentPromptError));
  Reflect.set(agentManager, "streamAgent", (_agentId: string, prompt: string) => {
    if (parentPromptFailures > 0) {
      parentPromptFailures -= 1;
      throw new Error("parent provider rejected the run");
    }
    parentPrompted = true;
    parentPrompts.push(prompt);
    events.push(`prompt ${prompt}`);
    resolveParentPrompt?.(prompt);
    return (async function* noop() {})();
  });
  Reflect.set(agentManager, "replaceAgentRun", async (_agentId: string, prompt: string) => {
    resolveParentPrompt?.(prompt);
    throw options?.parentPromptError;
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === "child-agent") {
      const parentAgentId =
        options?.childParentAgentId === undefined ? "caller-agent" : options.childParentAgentId;
      return {
        title: "Child Agent",
        labels: {
          ...childLabels,
          ...(parentAgentId ? { "paseo.parent-agent-id": parentAgentId } : {}),
        },
        archivedAt: childArchivedAt,
      };
    }
    if (agentId === "caller-agent" && options?.callerArchived) {
      return { title: "Caller Agent", labels: {}, archivedAt: "2026-11-12T00:00:00.000Z" };
    }
    return null;
  });

  return {
    archiveChildAfterFirstTurn() {
      archiveAfterFirstTurn({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        logger: options?.logger ?? createTestLogger(),
      });
    },
    unarchiveChild() {
      childArchivedAt = null;
    },
    events() {
      return events;
    },
    setChildLastAssistantMessage(message: string | null) {
      lastAssistantMessage = message;
    },
    startWatchingChild() {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: options?.requireParentOwnership,
        logger: options?.logger ?? createTestLogger(),
      });
    },
    promptChildWithoutNotice() {
      callerReadsNextTurn({
        agentManager,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
      });
    },
    resumeWatchingChild(state: FinishWatchState) {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: options?.requireParentOwnership,
        resume: { ...state, archiveOnFinish: Boolean(options?.childArchivesOnFinish) },
        logger: options?.logger ?? createTestLogger(),
      });
    },
    requestChildPermission(requestId = "permission-1") {
      childAgent.lifecycle = "running";
      childAgent.pendingPermissions.set(requestId, {
        id: requestId,
        provider: "claude",
        kind: "tool",
        name: "Run command",
        description: "Write the QA sentinel",
        input: {
          file_path: "/tmp/permission-qa.txt",
          content: "PASEO_PERMISSION_NOTIFY_QA_OK\n",
        },
      });
      subscriber.emit({
        type: "agent_state",
        agent: childAgent,
      });
      subscriber.emit({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_requested",
          provider: "codex",
          request: childAgent.pendingPermissions.get(requestId)!,
        },
      });
    },
    resolveChildPermission(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      subscriber.emit({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    resolveChildPermissionFromState(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      subscriber.emit({ type: "agent_state", agent: childAgent });
    },
    resolveChildPermissionWhileIdle(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      childAgent.lifecycle = "idle";
      subscriber.emit({ type: "agent_state", agent: childAgent });
      subscriber.emit({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    failChild() {
      childAgent.lifecycle = "error";
      subscriber.emit({ type: "agent_state", agent: childAgent });
    },
    runChild() {
      childAgent.lifecycle = "running";
      subscriber.emit({ type: "agent_state", agent: childAgent });
    },
    emitChildProgress() {
      subscriber.emit({
        type: "agent_stream",
        agentId: "child-agent",
        event: { type: "turn_started", provider: "pi" },
      } as AgentManagerEvent);
    },
    finishChild(pendingBackgroundWaits = 0) {
      childAgent.lifecycle = "running";
      subscriber.emit({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.pendingBackgroundWaits = pendingBackgroundWaits;
      childAgent.lifecycle = "idle";
      subscriber.emit({
        type: "agent_state",
        agent: childAgent,
      });
    },
    async finishChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });
      this.finishChild();

      return parentPrompt;
    },
    async closeChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });

      childAgent.lifecycle = "running";
      subscriber.emit({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "closed";
      subscriber.emit({
        type: "agent_state",
        agent: childAgent,
      });

      return parentPrompt;
    },
    parentPrompts() {
      return parentPrompts;
    },
    wasParentPrompted() {
      return parentPrompted;
    },
  };
}

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

test("sendPromptToAgent forwards the client message id as run options", async () => {
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", "agent-1");
  Reflect.set(agent, "provider", "codex");

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => agent),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => null),
  );

  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId: "agent-1",
    prompt: "hello",
    messageId: "msg-client-1",
    runOptions: { outputSchema: { type: "object" } },
    logger: createTestLogger(),
  });

  expect(streamAgentSpy).toHaveBeenCalledWith("agent-1", "hello", {
    outputSchema: { type: "object" },
    clientMessageId: "msg-client-1",
  });
});

test("sendPromptToAgent steers a supported active turn without replacing it", async () => {
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", "agent-1");
  Reflect.set(agent, "provider", "codex");
  Reflect.set(agent, "activeForegroundTurnId", "turn-1");

  const steerSpy = vi.fn().mockResolvedValue(true);
  const replaceSpy = vi.fn();
  const streamSpy = vi.fn();
  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => agent),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(true));
  Reflect.set(agentManager, "trySteerAgentRun", steerSpy);
  Reflect.set(agentManager, "replaceAgentRun", replaceSpy);
  Reflect.set(agentManager, "streamAgent", streamSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => null),
  );

  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId: "agent-1",
    prompt: "new mid-turn context",
    messageId: "msg-steer-1",
    logger: createTestLogger(),
  });

  expect(steerSpy).toHaveBeenCalledWith("agent-1", "new mid-turn context", {
    clientMessageId: "msg-steer-1",
  });
  expect(replaceSpy).not.toHaveBeenCalled();
  expect(streamSpy).not.toHaveBeenCalled();
});

test("finish notifications tell the parent the child's last assistant message", async () => {
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: "Implemented the cleanup and all checks pass.",
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt(
      "Agent child-agent (Child Agent) finished.\n\n<agent-response>\nImplemented the cleanup and all checks pass.\n</agent-response>",
    ),
  );
});

test("finish notifications truncate oversized child responses", async () => {
  const included = "x".repeat(4000);
  const omitted = "TAIL-MARKER".repeat(50);
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: included + omitted,
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain(included);
  expect(parentPrompt).toContain(
    `[truncated ${omitted.length} chars; use get_agent_activity for the full response]`,
  );
  expect(parentPrompt).not.toContain("TAIL-MARKER");
});

test("a child idle with pending background waits does not notify until its wake turn ends", async () => {
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: "Build passed.",
  });

  scenario.startWatchingChild();
  scenario.finishChild(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(scenario.parentPrompts()).toEqual([]);

  const parentPrompt = await scenario.finishChildAndReadParentPrompt();
  expect(parentPrompt).toContain("Agent child-agent (Child Agent) finished.");
  expect(parentPrompt).toContain("Build passed.");
  expect(scenario.parentPrompts()).toHaveLength(1);
});

test("closing a watched child notifies the caller", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  const parentPrompt = await scenario.closeChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt("Agent child-agent (Child Agent) was closed."),
  );
});

test("finish notifications survive permission responses", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();

  await vi.waitFor(() => {
    expect(scenario.parentPrompts()).toHaveLength(1);
  });
  expect(scenario.parentPrompts()[0]).toContain("needs permission.");
  const permissionPayload = scenario
    .parentPrompts()[0]
    .match(/<permission-request>\n([\s\S]+?)\n<\/permission-request>/)?.[1];
  expect(permissionPayload).toBeDefined();
  expect(JSON.parse(permissionPayload!)).toEqual({
    agentId: "child-agent",
    requestId: "permission-1",
    request: {
      id: "permission-1",
      provider: "claude",
      kind: "tool",
      name: "Run command",
      description: "Write the QA sentinel",
      input: {
        file_path: "/tmp/permission-qa.txt",
        content: "PASEO_PERMISSION_NOTIFY_QA_OK\n",
      },
    },
  });

  scenario.resolveChildPermission();
  scenario.finishChild();

  await vi.waitFor(() => {
    expect(scenario.parentPrompts()).toHaveLength(2);
  });
  expect(scenario.parentPrompts()[1]).toContain("finished.");
});

test("an idle permission resolution waits for the resumed run to finish", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));

  scenario.resolveChildPermissionWhileIdle();
  scenario.requestChildPermission("permission-2");
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(scenario.parentPrompts().every((prompt) => prompt.includes("needs permission."))).toBe(
    true,
  );

  scenario.resolveChildPermission("permission-2");
  scenario.finishChild();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(scenario.parentPrompts()[2]).toContain("finished.");
});

test("finish notifications report every concurrently pending permission", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission("permission-1");
  scenario.requestChildPermission("permission-2");

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(
    scenario.parentPrompts().map((prompt) => {
      const payload = prompt.match(/<permission-request>\n([\s\S]+?)\n<\/permission-request>/)?.[1];
      return JSON.parse(payload!).requestId;
    }),
  ).toEqual(["permission-1", "permission-2"]);

  scenario.resolveChildPermission("permission-1");
  scenario.resolveChildPermission("permission-2");
  scenario.finishChild();

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(scenario.parentPrompts()[2]).toContain("finished.");
});

test("finish notifications survive repeated permission cycles", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));
  scenario.resolveChildPermissionFromState();

  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  scenario.resolveChildPermission();
  scenario.finishChild();

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(
    scenario.parentPrompts().map((prompt) => prompt.match(/(needs permission|finished)\./)?.[1]),
  ).toEqual(["needs permission", "needs permission", "finished"]);
});

test("detaching a child ends its parent-owned finish notification", async () => {
  const scenario = createFinishNotificationScenario({
    childParentAgentId: null,
    requireParentOwnership: true,
  });
  scenario.startWatchingChild();
  scenario.finishChild();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scenario.wasParentPrompted()).toBe(false);
});

test("follow-up finish notifications do not require a parent relationship", async () => {
  const scenario = createFinishNotificationScenario({ childParentAgentId: "another-agent" });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain("Agent child-agent (Child Agent) finished.");
});

test("finish notifications log a rejected parent prompt without an unhandled rejection", async () => {
  const captured = createCapturedLogger();
  const scenario = createFinishNotificationScenario({
    parentPromptError: new Error("parent provider rejected replacement"),
    logger: captured.logger,
  });

  scenario.startWatchingChild();
  await scenario.finishChildAndReadParentPrompt();
  await captured.nextRecord;

  expect(captured.records).toEqual([
    expect.objectContaining({
      msg: "Failed to notify caller agent",
      childAgentId: "child-agent",
      callerAgentId: "caller-agent",
      reason: "finished",
      err: expect.objectContaining({ message: "parent provider rejected replacement" }),
    }),
  ]);
});

it("does not notify archived callers", async () => {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });
  Reflect.set(childAgent, "pendingPermissions", new Map());

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => {
      if (agentId === "child-agent") {
        return childAgent;
      }
      if (agentId === "caller-agent") {
        return callerAgent;
      }
      return null;
    }),
  );
  Reflect.set(
    agentManager,
    "subscribe",
    vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    }),
  );
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "getLastAssistantMessage", async () => "Done.");
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);
  Reflect.set(agentManager, "replaceAgentRun", replaceAgentRunSpy);

  const agentStorageGetSpy = vi.fn(async (agentId: string) =>
    agentId === "caller-agent" ? { archivedAt: "2024-01-01" } : null,
  );
  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", agentStorageGetSpy);

  setupFinishNotification({
    agentManager,
    agentStorage,
    childAgentId: "child-agent",
    callerAgentId: "caller-agent",
    logger: createTestLogger(),
  });

  expect(subscriber).not.toBeNull();

  childAgent.lifecycle = "running";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  childAgent.lifecycle = "idle";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  await vi.waitFor(() => {
    expect(agentStorageGetSpy).toHaveBeenCalledWith("caller-agent");
  });

  expect(streamAgentSpy).not.toHaveBeenCalled();
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
});

describe("stall notice (delta 54)", () => {
  test("a running child with no event for 20 minutes is reported once per silent stretch", async () => {
    vi.useFakeTimers();
    try {
      const scenario = createFinishNotificationScenario();
      scenario.startWatchingChild();
      scenario.runChild();

      await vi.advanceTimersByTimeAsync(FINISH_WATCH_STALL_MS - FINISH_WATCH_STALL_CHECK_MS);
      expect(scenario.parentPrompts()).toEqual([]);

      await vi.advanceTimersByTimeAsync(2 * FINISH_WATCH_STALL_CHECK_MS);
      expect(scenario.parentPrompts()).toHaveLength(1);
      expect(scenario.parentPrompts()[0]).toContain(
        "Agent child-agent (Child Agent) has shown no progress for 20 minutes.",
      );
      expect(scenario.parentPrompts()[0]).toContain("get_agent_activity");

      await vi.advanceTimersByTimeAsync(FINISH_WATCH_STALL_MS * 2);
      expect(scenario.parentPrompts()).toHaveLength(1);

      // Progress resets the clock; the finish is still reported afterwards.
      scenario.emitChildProgress();
      await vi.advanceTimersByTimeAsync(FINISH_WATCH_STALL_MS / 2);
      expect(scenario.parentPrompts()).toHaveLength(1);
      scenario.finishChild();
      await vi.advanceTimersByTimeAsync(1);
      expect(scenario.parentPrompts()).toHaveLength(2);
      expect(scenario.parentPrompts()[1]).toContain("Agent child-agent (Child Agent) finished.");
      await vi.advanceTimersByTimeAsync(FINISH_WATCH_STALL_MS * 2);
      expect(scenario.parentPrompts()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an idle child or one waiting on a permission is never reported as stalled", async () => {
    vi.useFakeTimers();
    try {
      const idle = createFinishNotificationScenario();
      idle.startWatchingChild();
      await vi.advanceTimersByTimeAsync(FINISH_WATCH_STALL_MS * 2);
      expect(idle.parentPrompts()).toEqual([]);

      const permission = createFinishNotificationScenario();
      permission.startWatchingChild();
      permission.requestChildPermission();
      await vi.advanceTimersByTimeAsync(FINISH_WATCH_STALL_MS * 2);
      expect(permission.parentPrompts().filter((prompt) => prompt.includes("no progress"))).toEqual(
        [],
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("finish watcher journal (delta 44)", () => {
  function recordingJournal(frozen = false) {
    const calls: string[] = [];
    const journal = {
      frozen,
      addWatcher: (child: string, caller: string, _owned: boolean, state?: FinishWatchState) => {
        let suffix = "";
        if (state) suffix = state.finishOwed ? " owed" : " reported";
        calls.push(`add ${child}->${caller}${suffix}`);
      },
      removeWatcher: (child: string, caller: string) => calls.push(`remove ${child}->${caller}`),
      isFrozen: () => journal.frozen,
    };
    return { journal, calls };
  }

  test("journals the watcher, keeps it with nothing owed once the finish is delivered, and drops it when the child closes", async () => {
    const { journal, calls } = recordingJournal();
    setFinishWatcherJournal(journal);
    try {
      const scenario = createFinishNotificationScenario({ childLastAssistantMessage: "Done." });
      scenario.startWatchingChild();
      expect(calls).toEqual(["add child-agent->caller-agent owed"]);
      await scenario.finishChildAndReadParentPrompt();
      await vi.waitFor(() =>
        expect(calls).toEqual([
          "add child-agent->caller-agent owed",
          "add child-agent->caller-agent reported",
        ]),
      );
      void scenario.closeChildAndReadParentPrompt();
      await vi.waitFor(() => expect(calls).toContain("remove child-agent->caller-agent"));
      expect(scenario.parentPrompts()).toHaveLength(1);
    } finally {
      setFinishWatcherJournal(null);
    }
  });

  test("a follow-up to an agent the caller does not own leaves the journal after its finish", async () => {
    const { journal, calls } = recordingJournal();
    setFinishWatcherJournal(journal);
    try {
      const scenario = createFinishNotificationScenario({ childParentAgentId: "another-agent" });
      scenario.startWatchingChild();
      await scenario.finishChildAndReadParentPrompt();
      await vi.waitFor(() => expect(calls).toContain("remove child-agent->caller-agent"));
    } finally {
      setFinishWatcherJournal(null);
    }
  });

  test("a child closed by the daemon shutting down keeps its watcher and prompts nobody", async () => {
    const { journal, calls } = recordingJournal();
    setFinishWatcherJournal(journal);
    try {
      const scenario = createFinishNotificationScenario();
      scenario.startWatchingChild();
      journal.frozen = true;
      void scenario.closeChildAndReadParentPrompt();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(scenario.wasParentPrompted()).toBe(false);
      expect(calls).toEqual(["add child-agent->caller-agent owed"]);
    } finally {
      setFinishWatcherJournal(null);
    }
  });
});

test("an errored child is reported once and its later finish is reported too", async () => {
  const scenario = createFinishNotificationScenario({ childLastAssistantMessage: "recovered" });
  scenario.startWatchingChild();
  scenario.failChild();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));
  scenario.failChild();
  expect(scenario.parentPrompts()[0]).toContain("errored.");
  expect(scenario.parentPrompts()[0]).toContain("Daseo keeps watching this agent");
  scenario.finishChild();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(scenario.parentPrompts()[1]).toContain("finished.");
});

describe("lead review and one watcher per pair (delta 80)", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("a report marked [lead review] reaches the caller while the child still holds a wait", async () => {
    const scenario = createFinishNotificationScenario({
      childLastAssistantMessage: "Round B is on the test skins.\n\n[lead review]",
    });
    scenario.startWatchingChild();
    scenario.finishChild(1);
    await flush();
    await flush();
    expect(scenario.parentPrompts()).toHaveLength(1);
    expect(scenario.parentPrompts()[0]).toContain("is waiting for your review");
    expect(scenario.parentPrompts()[0]).toContain("Round B is on the test skins.");

    // The wait wakes it, it only acknowledges, and the waits are gone: nothing new to say.
    scenario.setChildLastAssistantMessage("[wait noted]");
    scenario.finishChild(0);
    await flush();
    await flush();
    expect(scenario.parentPrompts()).toHaveLength(1);
  });

  test("after a review notice, a later new report is delivered as the finish", async () => {
    const scenario = createFinishNotificationScenario({
      childLastAssistantMessage: "Test round done.\n[Lead review]",
    });
    scenario.startWatchingChild();
    scenario.finishChild(1);
    await flush();
    await flush();
    scenario.setChildLastAssistantMessage("The HYM push gate failed; fixed and pushed again.");
    scenario.finishChild(0);
    await flush();
    await flush();
    expect(scenario.parentPrompts()).toHaveLength(2);
    expect(scenario.parentPrompts()[1]).toContain("finished");
    expect(scenario.parentPrompts()[1]).toContain("HYM push gate failed");
  });

  test("without the marker a child holding a wait stays quiet (delta 29 unchanged)", async () => {
    const scenario = createFinishNotificationScenario({
      childLastAssistantMessage: "Build is running; I will continue when it finishes.",
    });
    scenario.startWatchingChild();
    scenario.finishChild(1);
    await flush();
    await flush();
    expect(scenario.wasParentPrompted()).toBe(false);
  });

  test("a second watcher for the same child and caller replaces the first, so one finish is one notice", async () => {
    const scenario = createFinishNotificationScenario({ childLastAssistantMessage: "Done." });
    scenario.startWatchingChild();
    scenario.startWatchingChild();
    scenario.startWatchingChild();
    scenario.finishChild(0);
    await flush();
    await flush();
    expect(scenario.parentPrompts()).toHaveLength(1);
  });
});

describe("archiveOnFinish (delta 103)", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("the parent gets the finish with the last message first, then the child is archived", async () => {
    const scenario = createFinishNotificationScenario({
      childLastAssistantMessage: "Three sources agree on the price.",
      childArchivesOnFinish: true,
    });
    scenario.startWatchingChild();
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.events()).toHaveLength(2));

    expect(scenario.events()).toEqual([
      `prompt ${formatSystemNotificationPrompt(
        "Agent child-agent (Child Agent) finished.\n\n<agent-response>\nThree sources agree on the price.\n</agent-response>",
      )}`,
      "archive child-agent",
    ]);
  });

  test("an errored child is reported, then archived, and the watch ends", async () => {
    const scenario = createFinishNotificationScenario({
      childLastAssistantMessage: "Search provider returned 500.",
      childArchivesOnFinish: true,
    });
    scenario.startWatchingChild();
    scenario.failChild();
    await vi.waitFor(() => expect(scenario.events()).toHaveLength(2));

    expect(scenario.events()[0]).toContain("Agent child-agent (Child Agent) errored.");
    expect(scenario.events()[0]).toContain(
      "Daseo archives this agent after this notice because it was created with archiveOnFinish",
    );
    expect(scenario.events()[0]).toContain("Search provider returned 500.");
    expect(scenario.events()[0]).not.toContain("Daseo keeps watching this agent");
    expect(scenario.events()[1]).toBe("archive child-agent");

    scenario.finishChild();
    await flush();
    await flush();
    expect(scenario.events()).toHaveLength(2);
  });

  test("without the flag the child is reported and stays unarchived", async () => {
    const scenario = createFinishNotificationScenario({ childLastAssistantMessage: "Done." });
    scenario.startWatchingChild();
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));
    await flush();
    await flush();

    expect(scenario.events()).toEqual([`prompt ${scenario.parentPrompts()[0]}`]);
  });

  test("pending background waits hold both the notice and the archive until the wake turn ends", async () => {
    const scenario = createFinishNotificationScenario({
      childLastAssistantMessage: "Build passed.",
      childArchivesOnFinish: true,
    });
    scenario.startWatchingChild();
    scenario.finishChild(1);
    await flush();
    await flush();
    expect(scenario.events()).toEqual([]);

    scenario.finishChild(0);
    await vi.waitFor(() => expect(scenario.events()).toHaveLength(2));
    expect(scenario.events()[0]).toContain("finished.");
    expect(scenario.events()[0]).toContain("Build passed.");
    expect(scenario.events()[1]).toBe("archive child-agent");
  });

  test("a permission request is reported but does not archive", async () => {
    const scenario = createFinishNotificationScenario({ childArchivesOnFinish: true });
    scenario.startWatchingChild();
    scenario.requestChildPermission();
    await vi.waitFor(() => expect(scenario.events()).toHaveLength(1));
    await flush();
    await flush();

    expect(scenario.events()[0]).toContain("needs permission");
    expect(scenario.events()).toHaveLength(1);
  });

  test("a child whose caller is archived is archived without a prompt", async () => {
    const scenario = createFinishNotificationScenario({
      childArchivesOnFinish: true,
      callerArchived: true,
    });
    scenario.startWatchingChild();
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.events()).toEqual(["archive child-agent"]));
  });

  test("a later prompt's finish is reported and archived again", async () => {
    const scenario = createFinishNotificationScenario({
      childLastAssistantMessage: "First answer.",
      childArchivesOnFinish: true,
    });
    scenario.startWatchingChild();
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.events()).toHaveLength(2));

    // send_agent_prompt unarchives the child, runs it, and starts a new watcher.
    scenario.unarchiveChild();
    scenario.setChildLastAssistantMessage("Follow-up answer.");
    scenario.startWatchingChild();
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.events()).toHaveLength(4));
    expect(scenario.events()[2]).toContain("Follow-up answer.");
    expect(scenario.events()[3]).toBe("archive child-agent");
  });

  test("without notifyOnFinish the child is archived when its first turn ends with no wait held", async () => {
    const scenario = createFinishNotificationScenario({ childArchivesOnFinish: true });
    scenario.runChild();
    scenario.archiveChildAfterFirstTurn();
    scenario.finishChild(1);
    await flush();
    await flush();
    expect(scenario.events()).toEqual([]);

    scenario.finishChild(0);
    await vi.waitFor(() => expect(scenario.events()).toEqual(["archive child-agent"]));
    expect(scenario.wasParentPrompted()).toBe(false);
  });

  test("without notifyOnFinish an errored first turn is archived too", async () => {
    const scenario = createFinishNotificationScenario({ childArchivesOnFinish: true });
    scenario.runChild();
    scenario.archiveChildAfterFirstTurn();
    scenario.failChild();
    await vi.waitFor(() => expect(scenario.events()).toEqual(["archive child-agent"]));
  });
});

describe("a watch lasts as long as the parent-child relation (delta 106)", () => {
  const flush = async () => {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  test("a later turn nobody asked for is reported when it says something new, and only then", async () => {
    const scenario = createFinishNotificationScenario({ childLastAssistantMessage: "Report 1" });
    scenario.startWatchingChild();
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));

    // Its own sub-agent's notice, a wait wake, or the owner restarts it: a new report goes out.
    scenario.setChildLastAssistantMessage("Report 2\n\n[lead review]");
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
    expect(scenario.parentPrompts()[1]).toContain("Agent child-agent (Child Agent) finished.");
    expect(scenario.parentPrompts()[1]).toContain("Report 2");

    // The same report again, an acknowledgement, or nothing: no notice.
    for (const message of ["Report 2\n\n[lead review]", "[wait noted]", "", "   ", null]) {
      scenario.setChildLastAssistantMessage(message);
      scenario.finishChild();
      await flush();
    }
    expect(scenario.parentPrompts()).toHaveLength(2);
  });

  test("a turn the caller asked for is reported once even when the child repeats itself", async () => {
    const scenario = createFinishNotificationScenario({ childLastAssistantMessage: "Yes." });
    scenario.startWatchingChild();
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));

    scenario.runChild();
    scenario.startWatchingChild();
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
    expect(scenario.parentPrompts()[1]).toContain("Yes.");
    await flush();
    expect(scenario.parentPrompts()).toHaveLength(2);
  });

  test("a follow-up to an agent the caller does not own reports that one turn only", async () => {
    const scenario = createFinishNotificationScenario({
      childParentAgentId: "another-agent",
      childLastAssistantMessage: "Answer A",
    });
    scenario.startWatchingChild();
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));

    scenario.setChildLastAssistantMessage("Answer B");
    scenario.finishChild();
    await flush();
    expect(scenario.parentPrompts()).toHaveLength(1);
  });

  test("a turn the caller reads itself or declined is not reported again", async () => {
    const scenario = createFinishNotificationScenario({ childLastAssistantMessage: "Report 1" });
    scenario.startWatchingChild();
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));

    scenario.promptChildWithoutNotice();
    scenario.setChildLastAssistantMessage("Synchronous answer");
    scenario.finishChild();
    await flush();
    expect(scenario.parentPrompts()).toHaveLength(1);

    scenario.setChildLastAssistantMessage("Report 3");
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
    expect(scenario.parentPrompts()[1]).toContain("Report 3");
  });

  test("a failed finish delivery stays owed and goes out at the next turn end", async () => {
    const scenario = createFinishNotificationScenario({
      childLastAssistantMessage: "Report",
      parentPromptFailures: 1,
    });
    scenario.startWatchingChild();
    scenario.finishChild();
    await flush();
    expect(scenario.parentPrompts()).toEqual([]);

    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));
    expect(scenario.parentPrompts()[0]).toContain("Report");
  });

  test("a watch re-armed from the journal reports only what the caller has not seen", async () => {
    const scenario = createFinishNotificationScenario({ childLastAssistantMessage: "Report 1" });
    scenario.resumeWatchingChild({
      finishOwed: false,
      lastReportHash: finishReportHash("Report 1"),
    });
    scenario.finishChild();
    await flush();
    expect(scenario.parentPrompts()).toEqual([]);

    scenario.setChildLastAssistantMessage("Report 2");
    scenario.finishChild();
    await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));
    expect(scenario.parentPrompts()[0]).toContain("Report 2");
  });
});

interface AgentTree {
  watch(childAgentId: string, callerAgentId: string): void;
  run(agentId: string): void;
  idle(agentId: string, message: string | null, pendingBackgroundWaits?: number): void;
  turn(agentId: string, message: string | null, pendingBackgroundWaits?: number): void;
  fail(agentId: string): void;
  detach(agentId: string): void;
  promptsTo(agentId: string): string[];
}

/** Several agents under one fake manager: a lead, its implementer, the implementer's critic. */
function createAgentTree(parents: Record<string, string | null>): AgentTree {
  const subscribers = new Set<{
    callback: (event: AgentManagerEvent) => void;
    agentId: string | null;
  }>();
  const agents = new Map<string, ManagedAgent>();
  const messages = new Map<string, string | null>();
  const parentOf = new Map<string, string | null>(Object.entries(parents));
  const prompts: Array<{ to: string; text: string }> = [];
  const inFlight = new Set<string>();
  for (const agentId of Object.keys(parents)) {
    const agent: ManagedAgent = Object.create(null);
    Reflect.set(agent, "id", agentId);
    Reflect.set(agent, "lifecycle", "idle");
    Reflect.set(agent, "config", { title: agentId });
    Reflect.set(agent, "pendingPermissions", new Map());
    Reflect.set(agent, "pendingBackgroundWaits", 0);
    Reflect.set(agent, "labels", {});
    agents.set(agentId, agent);
  }

  function emit(agentId: string): void {
    const agent = agents.get(agentId)!;
    for (const subscriber of subscribers) {
      if (subscriber.agentId === null || subscriber.agentId === agentId) {
        subscriber.callback({ type: "agent_state", agent });
      }
    }
  }

  function startRun(agentId: string, prompt: string) {
    prompts.push({ to: agentId, text: prompt });
    inFlight.add(agentId);
    return (async function* noop() {})();
  }

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(agentManager, "getAgent", (agentId: string) => agents.get(agentId) ?? null);
  Reflect.set(
    agentManager,
    "subscribe",
    (callback: (event: AgentManagerEvent) => void, options?: { agentId?: string }) => {
      const subscriber = { callback, agentId: options?.agentId ?? null };
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  );
  Reflect.set(agentManager, "getLastAssistantMessage", async (agentId: string) => {
    return messages.get(agentId) ?? null;
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "trySteerAgentRun", async () => false);
  Reflect.set(agentManager, "hasInFlightRun", (agentId: string) => inFlight.has(agentId));
  Reflect.set(agentManager, "streamAgent", startRun);
  Reflect.set(agentManager, "replaceAgentRun", async (agentId: string, prompt: string) =>
    startRun(agentId, prompt),
  );

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (!agents.has(agentId)) return null;
    const parent = parentOf.get(agentId);
    return {
      title: agentId,
      labels: parent ? { "paseo.parent-agent-id": parent } : {},
      archivedAt: null,
    };
  });

  const tree: AgentTree = {
    watch(childAgentId, callerAgentId) {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId,
        callerAgentId,
        requireParentOwnership: true,
        logger: createTestLogger(),
      });
    },
    run(agentId) {
      inFlight.delete(agentId);
      agents.get(agentId)!.lifecycle = "running";
      emit(agentId);
    },
    idle(agentId, message, pendingBackgroundWaits = 0) {
      messages.set(agentId, message);
      const agent = agents.get(agentId)!;
      agent.pendingBackgroundWaits = pendingBackgroundWaits;
      agent.lifecycle = "idle";
      emit(agentId);
    },
    turn(agentId, message, pendingBackgroundWaits = 0) {
      tree.run(agentId);
      tree.idle(agentId, message, pendingBackgroundWaits);
    },
    fail(agentId) {
      agents.get(agentId)!.lifecycle = "error";
      emit(agentId);
    },
    detach(agentId) {
      parentOf.set(agentId, null);
    },
    promptsTo(agentId) {
      return prompts.filter((prompt) => prompt.to === agentId).map((prompt) => prompt.text);
    },
  };
  return tree;
}

describe("a child waiting on its own sub-agents is not finished (delta 106)", () => {
  const flush = async () => {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  function implementerWithCritic(): AgentTree {
    const tree = createAgentTree({ lead: null, implementer: "lead", critic: "implementer" });
    tree.watch("implementer", "lead");
    tree.run("implementer");
    // The implementer starts a UI critic with a finish watch and ends its turn.
    tree.watch("critic", "implementer");
    tree.run("critic");
    tree.idle("implementer", "The critic is running. I'll continue once its result comes back.");
    return tree;
  }

  test("the lead hears only the final report, once", async () => {
    const tree = implementerWithCritic();
    await flush();
    expect(tree.promptsTo("lead")).toEqual([]);

    tree.idle("critic", "PASS");
    await vi.waitFor(() => expect(tree.promptsTo("implementer")).toHaveLength(1));
    expect(tree.promptsTo("implementer")[0]).toContain("PASS");
    await flush();
    expect(tree.promptsTo("lead")).toEqual([]);

    tree.turn("implementer", "Final report: all checks pass.\n\n[lead review]");
    await vi.waitFor(() => expect(tree.promptsTo("lead")).toHaveLength(1));
    expect(tree.promptsTo("lead")[0]).toContain("Agent implementer (implementer) finished.");
    expect(tree.promptsTo("lead")[0]).toContain("Final report: all checks pass.");
    await flush();
    expect(tree.promptsTo("lead")).toHaveLength(1);
  });

  test("a held report marked [lead review] reaches the lead at once", async () => {
    const tree = createAgentTree({ lead: null, implementer: "lead", critic: "implementer" });
    tree.watch("implementer", "lead");
    tree.run("implementer");
    tree.watch("critic", "implementer");
    tree.run("critic");
    tree.idle("implementer", "Need your decision on the copy.\n[lead review]");
    await vi.waitFor(() => expect(tree.promptsTo("lead")).toHaveLength(1));
    expect(tree.promptsTo("lead")[0]).toContain("is waiting for your review");

    tree.idle("critic", "PASS");
    await vi.waitFor(() => expect(tree.promptsTo("implementer")).toHaveLength(1));
    tree.turn("implementer", "Need your decision on the copy.\n[lead review]");
    await flush();
    expect(tree.promptsTo("lead")).toHaveLength(1);
    tree.turn("implementer", "Critic passed; decision applied.");
    await vi.waitFor(() => expect(tree.promptsTo("lead")).toHaveLength(2));
    expect(tree.promptsTo("lead")[1]).toContain("finished.");
  });

  test("a sub-agent quiet for the cap stops holding, on a timer", async () => {
    vi.useFakeTimers();
    try {
      const tree = createAgentTree({ lead: null, implementer: "lead", critic: "implementer" });
      tree.watch("implementer", "lead");
      tree.run("implementer");
      tree.watch("critic", "implementer");
      tree.idle("implementer", "Waiting on the critic.");
      await vi.advanceTimersByTimeAsync(SUB_AGENT_HOLD_MAX_MS - 60_000);
      expect(tree.promptsTo("lead")).toEqual([]);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(tree.promptsTo("lead")).toHaveLength(1);
      expect(tree.promptsTo("lead")[0]).toContain("Waiting on the critic.");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a sub-agent watch that ends without a notice releases the hold", async () => {
    const tree = implementerWithCritic();
    await flush();
    tree.detach("critic");
    tree.idle("critic", "PASS");
    await vi.waitFor(() => expect(tree.promptsTo("lead")).toHaveLength(1));
    expect(tree.promptsTo("implementer")).toEqual([]);
    expect(tree.promptsTo("lead")[0]).toContain("The critic is running.");
  });

  test("a sub-agent that errors hands the decision back to its caller", async () => {
    const tree = implementerWithCritic();
    tree.fail("critic");
    await vi.waitFor(() => expect(tree.promptsTo("implementer")).toHaveLength(1));
    expect(tree.promptsTo("implementer")[0]).toContain("errored.");
    await flush();
    expect(tree.promptsTo("lead")).toEqual([]);

    tree.turn("implementer", "The critic failed; I reviewed the screens myself. Done.");
    await vi.waitFor(() => expect(tree.promptsTo("lead")).toHaveLength(1));
    expect(tree.promptsTo("lead")[0]).toContain("reviewed the screens myself");
  });
});
