import type pino from "pino";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import {
  attemptFirstAgentBranchAutoName,
  type AttemptFirstAgentBranchAutoNameResult,
} from "./paseo-worktree-service.js";
import type { GitMutationService } from "./session/git-mutation/git-mutation-service.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";
import {
  generateWorkspaceTitle,
  type GeneratedWorkspaceTitle,
  type GenerateWorkspaceTitleOptions,
} from "./workspace-title-generator.js";
import {
  generateBranchNameFromFirstAgentContext,
  type GeneratedWorkspaceName,
  type GenerateBranchNameFromFirstAgentContextOptions,
} from "./worktree-branch-name-generator.js";

type WorkspaceNameGenerator = typeof generateBranchNameFromFirstAgentContext;
type WorkspaceTitleGenerator = (
  options: GenerateWorkspaceTitleOptions,
) => Promise<GeneratedWorkspaceTitle | null>;

// Daseo: follow-up prompts re-evaluate an auto title. Short replies such as
// approvals never move the topic, and a minimum interval bounds the cost of
// spawning a metadata agent while the user is actively chatting.
const RETITLE_MIN_PROMPT_CHARS = 12;
const RETITLE_MIN_INTERVAL_MS = 3 * 60 * 1000;
const RETITLE_RECENT_PROMPTS = 4;

interface PromptTitleState {
  recentPrompts: string[];
  lastEvaluatedAt: number;
  running: boolean;
}

type CurrentSelection = GenerateBranchNameFromFirstAgentContextOptions["currentSelection"] | null;

interface WorkspaceAutoNameOptions {
  agentManager: AgentManager;
  workspaceRegistry: Pick<WorkspaceRegistry, "update" | "get">;
  workspaceGitService: WorkspaceGitService;
  providerSnapshotManager: ProviderSnapshotManager;
  readDaemonConfig: () => StructuredGenerationDaemonConfig;
  gitMutation: Pick<GitMutationService, "notifyGitMutation">;
  emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  logger: pino.Logger;
  generateWorkspaceName?: WorkspaceNameGenerator;
  generateWorkspaceTitle?: WorkspaceTitleGenerator;
  now?: () => number;
}

interface ScheduleContext {
  currentSelection?: CurrentSelection;
}

export class WorkspaceAutoName {
  private readonly agentManager: AgentManager;
  private readonly workspaceRegistry: Pick<WorkspaceRegistry, "update" | "get">;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly readDaemonConfig: () => StructuredGenerationDaemonConfig;
  private readonly gitMutation: Pick<GitMutationService, "notifyGitMutation">;
  private readonly emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  private readonly emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  private readonly logger: pino.Logger;
  private readonly generateWorkspaceName: WorkspaceNameGenerator;
  private readonly generateWorkspaceTitle: WorkspaceTitleGenerator;
  private readonly now: () => number;
  private readonly promptStates = new Map<string, PromptTitleState>();

  constructor(options: WorkspaceAutoNameOptions) {
    this.agentManager = options.agentManager;
    this.workspaceRegistry = options.workspaceRegistry;
    this.workspaceGitService = options.workspaceGitService;
    this.providerSnapshotManager = options.providerSnapshotManager;
    this.readDaemonConfig = options.readDaemonConfig;
    this.gitMutation = options.gitMutation;
    this.emitWorkspaceUpdateForCwd = options.emitWorkspaceUpdateForCwd;
    this.emitWorkspaceUpdateForWorkspaceId = options.emitWorkspaceUpdateForWorkspaceId;
    this.logger = options.logger;
    this.generateWorkspaceName =
      options.generateWorkspaceName ?? generateBranchNameFromFirstAgentContext;
    this.generateWorkspaceTitle = options.generateWorkspaceTitle ?? generateWorkspaceTitle;
    this.now = options.now ?? Date.now;
  }

  /**
   * Daseo: name or rename a workspace from a user prompt sent to an agent that
   * already lives in it. Covers the empty-workspace launch (the first agent is
   * created inside an existing untitled workspace) and topic changes later in
   * the session. Manual and legacy titles are never touched.
   */
  scheduleForPrompt(input: { workspaceId: string; prompt: string }): void {
    const prompt = input.prompt.trim();
    if (!prompt) {
      return;
    }
    const state = this.rememberPrompt(input.workspaceId, prompt);
    if (state.running) {
      return;
    }
    state.running = true;
    this.schedule(
      () =>
        this.maybeRetitleFromPrompts(input.workspaceId, state).finally(() => {
          state.running = false;
        }),
      { workspaceId: input.workspaceId, message: "Failed to auto-name workspace from prompt" },
    );
  }

  private rememberPrompt(workspaceId: string, prompt: string): PromptTitleState {
    let state = this.promptStates.get(workspaceId);
    if (!state) {
      state = { recentPrompts: [], lastEvaluatedAt: 0, running: false };
      this.promptStates.set(workspaceId, state);
    }
    state.recentPrompts.push(prompt);
    if (state.recentPrompts.length > RETITLE_RECENT_PROMPTS) {
      state.recentPrompts.splice(0, state.recentPrompts.length - RETITLE_RECENT_PROMPTS);
    }
    return state;
  }

  private async maybeRetitleFromPrompts(
    workspaceId: string,
    state: PromptTitleState,
  ): Promise<void> {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace || workspace.archivedAt) {
      this.promptStates.delete(workspaceId);
      return;
    }
    const currentTitle = workspace.title;
    if (currentTitle !== null && workspace.titleSource !== "auto") {
      return;
    }
    const latest = state.recentPrompts.at(-1) ?? "";
    const now = this.now();
    if (currentTitle !== null) {
      if (latest.length < RETITLE_MIN_PROMPT_CHARS) {
        return;
      }
      if (now - state.lastEvaluatedAt < RETITLE_MIN_INTERVAL_MS) {
        return;
      }
    }
    state.lastEvaluatedAt = now;
    const generated = await this.generateWorkspaceTitle({
      agentManager: this.agentManager,
      cwd: workspace.cwd,
      providerSnapshotManager: this.providerSnapshotManager,
      daemonConfig: this.readDaemonConfig(),
      currentTitle,
      recentPrompts: [...state.recentPrompts],
      logger: this.logger,
    });
    const nextTitle = generated && !generated.keep ? generated.title : null;
    if (!nextTitle || nextTitle === currentTitle) {
      return;
    }
    let applied = false;
    await this.workspaceRegistry.update(workspaceId, (current) => {
      // A rename or another auto-name that landed while generating wins.
      if (current.title !== currentTitle || current.titleSource !== workspace.titleSource) {
        return current;
      }
      applied = true;
      return {
        ...current,
        title: nextTitle,
        titleSource: "auto",
        updatedAt: new Date().toISOString(),
      };
    });
    if (applied) {
      this.logger.info(
        { workspaceId, previousTitle: currentTitle, title: nextTitle },
        "Workspace auto-titled from prompt",
      );
      await this.emitWorkspaceUpdateForWorkspaceId(workspaceId);
    }
  }

  scheduleForWorktree(
    input: {
      workspace: PersistedWorkspaceRecord;
      firstAgentContext: FirstAgentContext;
    },
    context: ScheduleContext = {},
  ): void {
    this.rememberFirstAgentPrompt(input.workspace.workspaceId, input.firstAgentContext);
    this.schedule(
      () =>
        this.maybeAutoNameWorkspaceBranchForFirstAgent({
          ...input,
          currentSelection: context.currentSelection ?? null,
        }),
      {
        cwd: input.workspace.cwd,
        message: "Failed to auto-name worktree branch",
      },
    );
  }

  scheduleForDirectory(
    input: {
      workspaceId: string;
      cwd: string;
      firstAgentContext: FirstAgentContext;
    },
    context: ScheduleContext = {},
  ): void {
    this.rememberFirstAgentPrompt(input.workspaceId, input.firstAgentContext);
    this.schedule(
      () =>
        this.maybeAutoNameDirectoryWorkspaceTitle({
          ...input,
          currentSelection: context.currentSelection ?? null,
        }),
      { cwd: input.cwd, message: "Failed to auto-name directory workspace title" },
    );
  }

  private rememberFirstAgentPrompt(workspaceId: string, context: FirstAgentContext): void {
    const prompt = context.prompt?.trim();
    if (prompt) {
      const state = this.rememberPrompt(workspaceId, prompt);
      state.lastEvaluatedAt = this.now();
    }
  }

  private async maybeAutoNameWorkspaceBranchForFirstAgent(input: {
    workspace: PersistedWorkspaceRecord;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<void> {
    const worktreeRoot = input.workspace.worktreeRoot ?? input.workspace.cwd;
    let generated: GeneratedWorkspaceName | null = null;
    const result: AttemptFirstAgentBranchAutoNameResult = await attemptFirstAgentBranchAutoName({
      cwd: worktreeRoot,
      firstAgentContext: input.firstAgentContext,
      generateBranchNameFromContext: ({ firstAgentContext }) => {
        return this.generateFromContext({
          cwd: input.workspace.cwd,
          firstAgentContext,
          currentSelection: input.currentSelection,
        }).then((nextGenerated) => {
          generated = nextGenerated;
          return nextGenerated?.branch ?? null;
        });
      },
    });

    if (!generated) {
      generated = await this.generateFromContext({
        cwd: input.workspace.cwd,
        firstAgentContext: input.firstAgentContext,
        currentSelection: input.currentSelection,
      });
    }
    const generatedTitle = generated?.title ?? null;
    if (!generatedTitle) {
      return;
    }

    // K4: re-read from the registry before writing so any concurrent upsert
    // that happened between workspace creation and this async path is not clobbered.
    // When the first-agent rename changed the git branch too, persist that branch
    // alongside the title — both are this path's own fields.
    await this.applyGeneratedWorkspaceTitle(input.workspace.workspaceId, {
      title: generatedTitle,
      ...(result.renamed ? { branch: result.branchName } : {}),
      promptTitle: resolveFirstAgentPromptTitle(input.firstAgentContext),
    });
    if (result.renamed) {
      await this.gitMutation.notifyGitMutation(worktreeRoot, "rename-branch");
    }
    await this.emitWorkspaceUpdateForCwd(input.workspace.cwd);
  }

  private async maybeAutoNameDirectoryWorkspaceTitle(input: {
    workspaceId: string;
    cwd: string;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<void> {
    const generated = await this.generateFromContext({
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
      currentSelection: input.currentSelection,
    });
    const title = generated?.title ?? null;
    if (!title) {
      return;
    }
    // K4: applyGeneratedWorkspaceTitle re-reads from the registry before writing.
    // Directory workspaces have no branch — write only the title.
    await this.applyGeneratedWorkspaceTitle(input.workspaceId, {
      title,
      promptTitle: resolveFirstAgentPromptTitle(input.firstAgentContext),
    });
    await this.emitWorkspaceUpdateForWorkspaceId(input.workspaceId);
  }

  private async applyGeneratedWorkspaceTitle(
    workspaceId: string,
    input: { title: string; branch?: string | null; promptTitle?: string | null },
  ): Promise<void> {
    await this.workspaceRegistry.update(workspaceId, (current) => {
      let title = current.title;
      let titleSource = current.titleSource;
      if (
        current.titleSource !== "manual" &&
        (!title || (input.promptTitle && title === input.promptTitle))
      ) {
        title = input.title;
        titleSource = "auto";
      }
      return {
        ...current,
        title,
        titleSource,
        ...(input.branch ? { branch: input.branch } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private generateFromContext(input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<GeneratedWorkspaceName | null> {
    return this.generateWorkspaceName({
      agentManager: this.agentManager,
      cwd: input.cwd,
      workspaceGitService: this.workspaceGitService,
      providerSnapshotManager: this.providerSnapshotManager,
      daemonConfig: this.readDaemonConfig(),
      currentSelection: input.currentSelection ?? undefined,
      firstAgentContext: input.firstAgentContext,
      logger: this.logger,
    });
  }

  private schedule(
    run: () => Promise<void>,
    context: { cwd?: string; workspaceId?: string; message: string },
  ): void {
    setTimeout(() => {
      void run().catch((error) => {
        const { message, ...fields } = context;
        this.logger.warn({ err: error, ...fields }, message);
      });
    }, 0);
  }
}
