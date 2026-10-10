import pino from "pino";
import { expect, test } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import type {
  GeneratedWorkspaceTitle,
  GenerateWorkspaceTitleOptions,
} from "./workspace-title-generator.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("auto-name preserves workspace archival that lands during its metadata write", async () => {
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-auto-name",
    projectId: "project-auto-name",
    cwd: "/workspace",
    kind: "directory",
    displayName: "workspace",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
  const mutationStarted = deferred();
  const allowMutation = deferred();
  const updateEmitted = deferred();
  const workspaceRegistry = {
    update: async (_workspaceId, updater) => {
      mutationStarted.resolve();
      await allowMutation.promise;
      workspace = updater(workspace);
      return workspace;
    },
    get: async () => workspace,
  } satisfies Pick<WorkspaceRegistry, "update" | "get">;
  const autoName = new WorkspaceAutoName({
    agentManager: {} as AgentManager,
    workspaceRegistry,
    workspaceGitService: {} as WorkspaceGitService,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => updateEmitted.resolve(),
    logger: pino({ level: "silent" }),
    generateWorkspaceName: async () => ({ title: "generated", branch: null }),
  });

  autoName.scheduleForDirectory({
    workspaceId: workspace.workspaceId,
    cwd: workspace.cwd,
    firstAgentContext: { prompt: "Name this workspace" },
  });
  await mutationStarted.promise;
  const archivedAt = "2026-08-08T00:01:00.000Z";
  workspace = { ...workspace, updatedAt: archivedAt, archivedAt };
  allowMutation.resolve();
  await updateEmitted.promise;

  expect(workspace).toMatchObject({
    title: "generated",
    archivedAt,
  });
});

interface PromptHarness {
  autoName: WorkspaceAutoName;
  workspace(): PersistedWorkspaceRecord;
  rename(title: string | null, titleSource: "auto" | "manual" | null): void;
  calls: GenerateWorkspaceTitleOptions[];
  advance(ms: number): void;
  nextResult(result: GeneratedWorkspaceTitle | null): void;
  settled(): Promise<void>;
}

function createPromptHarness(): PromptHarness {
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "workspace-prompt",
    projectId: "project-prompt",
    cwd: "/Users/someone",
    kind: "directory",
    displayName: "someone",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
  });
  let now = 1_000_000;
  let result: GeneratedWorkspaceTitle | null = null;
  const calls: GenerateWorkspaceTitleOptions[] = [];
  const autoName = new WorkspaceAutoName({
    agentManager: {} as AgentManager,
    workspaceRegistry: {
      update: async (_workspaceId, updater) => {
        workspace = updater(workspace);
        return workspace;
      },
      get: async () => workspace,
    },
    workspaceGitService: {} as WorkspaceGitService,
    providerSnapshotManager: {} as ProviderSnapshotManager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => {},
    logger: pino({ level: "silent" }),
    generateWorkspaceTitle: async (options) => {
      calls.push(options);
      return result;
    },
    now: () => now,
  });
  return {
    autoName,
    workspace: () => workspace,
    rename: (title, titleSource) => {
      workspace = { ...workspace, title, titleSource };
    },
    calls,
    advance: (ms) => {
      now += ms;
    },
    nextResult: (next) => {
      result = next;
    },
    settled: async () => {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

test("first prompt in an untitled workspace names it with an auto title", async () => {
  const harness = createPromptHarness();
  harness.nextResult({ keep: false, title: "Daseo 세션 자동 이름" });

  harness.autoName.scheduleForPrompt({ workspaceId: "workspace-prompt", prompt: "진행" });
  await harness.settled();

  expect(harness.calls).toHaveLength(1);
  expect(harness.calls[0]).toMatchObject({ currentTitle: null, recentPrompts: ["진행"] });
  expect(harness.workspace()).toMatchObject({
    title: "Daseo 세션 자동 이름",
    titleSource: "auto",
  });
});

test("manual and legacy titles are never re-evaluated", async () => {
  const harness = createPromptHarness();
  harness.nextResult({ keep: false, title: "Something else" });

  harness.rename("내가 정한 이름", "manual");
  harness.autoName.scheduleForPrompt({
    workspaceId: "workspace-prompt",
    prompt: "이제 완전히 다른 작업을 해보자 결제 페이지 버그 수정",
  });
  await harness.settled();
  harness.rename("[HYM 아침 전수점검]", null);
  harness.autoName.scheduleForPrompt({
    workspaceId: "workspace-prompt",
    prompt: "이제 완전히 다른 작업을 해보자 결제 페이지 버그 수정",
  });
  await harness.settled();

  expect(harness.calls).toHaveLength(0);
  expect(harness.workspace().title).toBe("[HYM 아침 전수점검]");
});

test("auto titles change only on a long prompt after the interval, and keep wins", async () => {
  const harness = createPromptHarness();
  harness.rename("Daseo 세션 자동 이름", "auto");

  harness.autoName.scheduleForPrompt({ workspaceId: "workspace-prompt", prompt: "진행" });
  await harness.settled();
  expect(harness.calls).toHaveLength(0);

  harness.nextResult({ keep: true, title: null });
  harness.autoName.scheduleForPrompt({
    workspaceId: "workspace-prompt",
    prompt: "이름 생성 모델을 Luna 말고 다른 걸로도 테스트해볼까",
  });
  await harness.settled();
  expect(harness.calls).toHaveLength(1);
  expect(harness.calls[0]?.currentTitle).toBe("Daseo 세션 자동 이름");
  expect(harness.workspace().title).toBe("Daseo 세션 자동 이름");

  harness.nextResult({ keep: false, title: "HYM 결제 페이지 버그" });
  harness.autoName.scheduleForPrompt({
    workspaceId: "workspace-prompt",
    prompt: "이제 HYM 결제 페이지 버그 좀 봐줘 500 에러 나",
  });
  await harness.settled();
  expect(harness.calls).toHaveLength(1);

  harness.advance(3 * 60 * 1000);
  harness.autoName.scheduleForPrompt({
    workspaceId: "workspace-prompt",
    prompt: "HYM 결제 페이지 500 에러 로그 다시 확인해줘",
  });
  await harness.settled();
  expect(harness.calls).toHaveLength(2);
  expect(harness.calls[1]?.recentPrompts).toHaveLength(4);
  expect(harness.workspace()).toMatchObject({
    title: "HYM 결제 페이지 버그",
    titleSource: "auto",
  });
});
