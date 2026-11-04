import type pino from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { FileBackedAgentTimelineStore } from "../agent/file-backed-agent-timeline-store.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { StructuredGenerationDaemonConfig } from "../agent/structured-generation-providers.js";
import { createStructuredHistoryAiRanker } from "./history-ai-ranker.js";
import { HistorySearchService, type HistorySearchSettings } from "./history-search-service.js";
import { toIndexableAgent } from "./indexable-agent.js";
import { HISTORY_EMBEDDING_MODEL } from "./semantic/embedding-model.js";
import { createWorkerEmbedder } from "./semantic/worker-embedder.js";

/** Lets startup finish (providers, relay, first clients) before the first index pass reads disk. */
const START_DELAY_MS = 5_000;

/**
 * Wires History search into the daemon. Returns null when this runtime cannot
 * host the index (node:sqlite needs Node 22.5+); History then keeps its title
 * search and the app sees no content-search feature flag.
 */
export async function createDaemonHistorySearch(input: {
  settings: HistorySearchSettings;
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  durableTimelineStore: FileBackedAgentTimelineStore;
  providerSnapshotManager: ProviderSnapshotManager;
  readDaemonConfig: () => StructuredGenerationDaemonConfig;
  logger: pino.Logger;
}): Promise<HistorySearchService | null> {
  const logger = input.logger.child({ module: "history-search" });
  let service: HistorySearchService;
  try {
    service = await HistorySearchService.create({
      paseoHome: input.paseoHome,
      logger: input.logger,
      semanticEnabled: input.settings.semantic,
      listRootAgents: async () =>
        (await input.agentStorage.list()).flatMap((record) => {
          const agent = toIndexableAgent(record);
          return agent ? [agent] : [];
        }),
      resolveRootAgent: async (agentId) => {
        const live = input.agentManager.getAgent(agentId);
        const record = await input.agentStorage.get(agentId);
        if (live) {
          return toIndexableAgent({
            id: live.id,
            provider: live.provider,
            internal: live.internal,
            labels: live.labels,
            persistence: live.persistence ?? record?.persistence ?? null,
          });
        }
        return record ? toIndexableAgent(record) : null;
      },
      createEmbedder: (modelDir) =>
        createWorkerEmbedder({ modelDir, spec: HISTORY_EMBEDDING_MODEL, logger }),
      aiRanker: createStructuredHistoryAiRanker({
        agentManager: input.agentManager,
        providerSnapshotManager: input.providerSnapshotManager,
        readDaemonConfig: input.readDaemonConfig,
        logger,
      }),
    });
  } catch (error) {
    logger.warn({ err: error }, "History content search unavailable on this runtime");
    return null;
  }
  input.durableTimelineStore.onCommittedChange((agentId) => service.notifyTimelineChanged(agentId));
  service.start({ delayMs: START_DELAY_MS });
  return service;
}
