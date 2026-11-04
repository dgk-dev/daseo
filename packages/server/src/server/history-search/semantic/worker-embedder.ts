import path from "node:path";
import type pino from "pino";
import type { EmbeddingModelSpec } from "./embedding-model.js";
import { EmbeddingWorkerClient } from "./embedding-worker-client.js";
import type { HistoryEmbedder } from "./history-semantic-index.js";

/** A cold start loads the model (about half a second warm, longer on first read). */
const QUERY_TIMEOUT_MS = 8_000;
const PASSAGE_BATCH_TIMEOUT_MS = 120_000;

export function createWorkerEmbedder(input: {
  modelDir: string;
  spec: EmbeddingModelSpec;
  logger: pino.Logger;
}): HistoryEmbedder {
  const client = new EmbeddingWorkerClient({
    logger: input.logger,
    model: {
      modelPath: path.join(input.modelDir, input.spec.files.model.path),
      tokenizerPath: path.join(input.modelDir, input.spec.files.tokenizer.path),
      tokenizerConfigPath: path.join(input.modelDir, input.spec.files.tokenizerConfig.path),
      maxTokens: input.spec.maxTokens,
    },
  });
  return {
    embedPassages(texts) {
      return client.embed({
        prefix: input.spec.passagePrefix,
        texts,
        timeoutMs: PASSAGE_BATCH_TIMEOUT_MS,
      });
    },
    async embedQuery(text) {
      const [vector] = await client.embed({
        prefix: input.spec.queryPrefix,
        texts: [text],
        timeoutMs: QUERY_TIMEOUT_MS,
      });
      if (!vector) throw new Error("Embedding worker returned no query vector");
      return vector;
    },
    shutdown() {
      client.shutdown();
    },
  };
}
