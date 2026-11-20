import type { ListCommandsRequest } from "@getpaseo/protocol/messages";
import type pino from "pino";
import { expandTilde } from "../../utils/path.js";
import { buildConfigOverrides, isStoredAgentProviderAvailable } from "../persistence-hooks.js";
import { type AgentManager, normalizeRequestedModelId } from "./agent-manager.js";
import type { AgentSessionConfig, AgentSlashCommand } from "./agent-sdk-types.js";
import type { AgentStorage } from "./agent-storage.js";
import type { CommandListCache } from "./command-list-cache.js";

export interface ListAgentCommandsDeps {
  agentManager: Pick<AgentManager, "getAgent" | "getRegisteredProviderIds" | "listDraftCommands">;
  agentStorage: Pick<AgentStorage, "get">;
  commandListCache: CommandListCache;
  logger: pino.Logger;
  /** How long a live agent gets to answer before the cache answers; defaults to 2 s. */
  liveListTimeoutMs?: number;
}

/**
 * A live Pi answers `get_commands` in 1-3 ms, even mid-turn, while its RPC timeout is 60 s
 * (`rpcTimeoutMs`); an agent being unloaded or a Pi whose process died between turns would make
 * the user wait that long, so past this bound the cache answers.
 */
export const LIVE_LIST_COMMANDS_TIMEOUT_MS = 2_000;

class LiveListTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`Live command listing did not answer within ${waitedMs}ms`);
    this.name = "LiveListTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LiveListTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function storedListConfig(input: {
  provider: string;
  cwd: string;
  modeId?: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
}): AgentSessionConfig {
  return {
    provider: input.provider,
    cwd: input.cwd,
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
  };
}

async function listThroughCache(
  deps: ListAgentCommandsDeps,
  config: AgentSessionConfig,
): Promise<AgentSlashCommand[]> {
  return deps.commandListCache.resolve({ provider: config.provider, cwd: config.cwd }, () =>
    deps.agentManager.listDraftCommands(config, { resolveDefaultModel: true }),
  );
}

export interface ListAgentCommandsInput {
  agentId: string;
  draftConfig?: ListCommandsRequest["draftConfig"];
}

export interface ListAgentCommandsResult {
  commands: AgentSlashCommand[];
  error: string | null;
}

/**
 * Answers `list_commands_request` (Daseo delta 138). A live agent answers itself and its list is
 * cached; when it fails or does not answer within `LIVE_LIST_COMMANDS_TIMEOUT_MS`, the cache
 * answers as for a stored agent. A stored agent that is not loaded is never loaded for this: it answers from the
 * provider+cwd cache, or on a miss through a throwaway listing session. A draft composer answers
 * from the same cache. Throws for failures the caller reports as the response's error.
 */
export async function listAgentCommands(
  deps: ListAgentCommandsDeps,
  input: ListAgentCommandsInput,
): Promise<ListAgentCommandsResult> {
  const { agentId, draftConfig } = input;
  const live = deps.agentManager.getAgent(agentId);
  if (live) {
    if (!live.session?.listCommands) {
      return { commands: [], error: "Agent does not support listing commands" };
    }
    const key = { provider: live.provider, cwd: live.cwd };
    // A late live answer is still stored, even after the cache answered.
    const liveList = live.session.listCommands().then(async (commands) => {
      await deps.commandListCache.store(key, commands);
      return commands;
    });
    try {
      const commands = await withTimeout(
        liveList,
        deps.liveListTimeoutMs ?? LIVE_LIST_COMMANDS_TIMEOUT_MS,
      );
      return { commands, error: null };
    } catch (error) {
      liveList.catch(() => undefined);
      deps.logger.debug(
        { err: error, agentId, provider: live.provider },
        "Live command listing failed; answering from the command list cache",
      );
      const config = storedListConfig({
        ...key,
        modeId: live.config.modeId,
        model: live.config.model,
        thinkingOptionId: live.config.thinkingOptionId,
      });
      return { commands: await listThroughCache(deps, config), error: null };
    }
  }

  const stored = await deps.agentStorage.get(agentId);
  if (stored && !stored.archivedAt) {
    if (!isStoredAgentProviderAvailable(stored, deps.agentManager.getRegisteredProviderIds())) {
      throw new Error(`Agent ${agentId} references unavailable provider '${stored.provider}'`);
    }
    const overrides = buildConfigOverrides(stored);
    const config = storedListConfig({
      provider: stored.provider,
      cwd: stored.cwd,
      modeId: overrides.modeId,
      model: overrides.model,
      thinkingOptionId: overrides.thinkingOptionId,
    });
    return { commands: await listThroughCache(deps, config), error: null };
  }

  if (draftConfig) {
    const config: AgentSessionConfig = {
      provider: draftConfig.provider,
      cwd: expandTilde(draftConfig.cwd),
      ...(draftConfig.modeId ? { modeId: draftConfig.modeId } : {}),
      ...(draftConfig.model ? { model: draftConfig.model } : {}),
      ...(draftConfig.thinkingOptionId ? { thinkingOptionId: draftConfig.thinkingOptionId } : {}),
    };
    // Without a model the draft lister answers an empty list; that is not a list for the cwd.
    if (!normalizeRequestedModelId(config.model)) {
      return { commands: await deps.agentManager.listDraftCommands(config), error: null };
    }
    const commands = await deps.commandListCache.resolve(
      { provider: config.provider, cwd: config.cwd },
      () => deps.agentManager.listDraftCommands(config),
    );
    return { commands, error: null };
  }

  return { commands: [], error: `Agent not found: ${agentId}` };
}
