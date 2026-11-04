import { readFile } from "node:fs/promises";
import { setPriority } from "node:os";
import { Tokenizer } from "@huggingface/tokenizers";
import ort from "onnxruntime-node";
import type {
  EmbeddingWorkerModelConfig,
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
} from "./embedding-worker-protocol.js";

process.title = "Paseo History Search";
// Background embedding must never compete with the owner's foreground work.
try {
  setPriority(10);
} catch {
  // Lowering priority is best-effort.
}

interface LoadedModel {
  key: string;
  tokenizer: Tokenizer;
  session: ort.InferenceSession;
  padId: number;
  eosId: number;
  usesTokenTypeIds: boolean;
  maxTokens: number;
}

let loaded: Promise<LoadedModel> | null = null;
let loadedKey: string | null = null;
let ipcClosing = false;

function modelKey(config: EmbeddingWorkerModelConfig): string {
  return `${config.modelPath}:${config.tokenizerPath}:${config.maxTokens}`;
}

async function loadModel(config: EmbeddingWorkerModelConfig): Promise<LoadedModel> {
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readFile(config.tokenizerPath, "utf8").then((text) => JSON.parse(text) as object),
    readFile(config.tokenizerConfigPath, "utf8").then((text) => JSON.parse(text) as object),
  ]);
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  const session = await ort.InferenceSession.create(config.modelPath, {
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  });
  const padId = tokenizer.token_to_id("<pad>");
  const eosId = tokenizer.token_to_id("</s>");
  if (padId === undefined || eosId === undefined) {
    throw new Error("Embedding tokenizer has no <pad> or </s> token");
  }
  return {
    key: modelKey(config),
    tokenizer,
    session,
    padId,
    eosId,
    usesTokenTypeIds: session.inputNames.includes("token_type_ids"),
    maxTokens: config.maxTokens,
  };
}

function getModel(config: EmbeddingWorkerModelConfig): Promise<LoadedModel> {
  const key = modelKey(config);
  if (!loaded || loadedKey !== key) {
    loadedKey = key;
    loaded = loadModel(config);
    loaded.catch(() => {
      if (loadedKey === key) {
        loaded = null;
        loadedKey = null;
      }
    });
  }
  return loaded;
}

/** Truncates like the reference pipeline: keep the head, end on </s>. */
function encode(model: LoadedModel, text: string): number[] {
  const ids = model.tokenizer.encode(text).ids;
  if (ids.length <= model.maxTokens) return ids;
  return [...ids.slice(0, model.maxTokens - 1), model.eosId];
}

/** Mean pooling over real tokens, then L2 normalization (the e5 recipe). */
async function embed(model: LoadedModel, texts: readonly string[]): Promise<Float32Array[]> {
  const encoded = texts.map((text) => encode(model, text));
  const batch = encoded.length;
  const length = Math.max(...encoded.map((ids) => ids.length));
  const inputIds = new BigInt64Array(batch * length).fill(BigInt(model.padId));
  const attention = new BigInt64Array(batch * length);
  encoded.forEach((ids, row) => {
    ids.forEach((id, column) => {
      inputIds[row * length + column] = BigInt(id);
      attention[row * length + column] = 1n;
    });
  });
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", inputIds, [batch, length]),
    attention_mask: new ort.Tensor("int64", attention, [batch, length]),
  };
  if (model.usesTokenTypeIds) {
    feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(batch * length), [
      batch,
      length,
    ]);
  }
  const outputs = await model.session.run(feeds);
  const outputName = model.session.outputNames[0];
  const hidden = outputName ? outputs[outputName] : undefined;
  if (!hidden || hidden.dims.length !== 3) {
    throw new Error("Embedding model returned no token embeddings");
  }
  const dimensions = Number(hidden.dims[2]);
  const data = hidden.data as Float32Array;
  return encoded.map((ids, row) => {
    const vector = new Float32Array(dimensions);
    for (let column = 0; column < ids.length; column += 1) {
      const offset = (row * length + column) * dimensions;
      for (let d = 0; d < dimensions; d += 1) vector[d] += data[offset + d] ?? 0;
    }
    let norm = 0;
    for (let d = 0; d < dimensions; d += 1) {
      vector[d] /= ids.length;
      norm += vector[d] * vector[d];
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dimensions; d += 1) vector[d] /= norm;
    return vector;
  });
}

function send(message: EmbeddingWorkerResponse): void {
  if (ipcClosing || !process.connected || !process.send) return;
  try {
    process.send(message, (error: Error | null) => {
      if (error) ipcClosing = true;
    });
  } catch {
    ipcClosing = true;
  }
}

async function handle(request: EmbeddingWorkerRequest): Promise<void> {
  try {
    const model = await getModel(request.model);
    const vectors = await embed(
      model,
      request.texts.map((text) => `${request.prefix}${text}`),
    );
    send({ type: "response", requestId: request.requestId, ok: true, vectors });
  } catch (error) {
    send({
      type: "response",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// One request at a time: the parent already orders queries ahead of backfill,
// and concurrent ONNX runs would only raise peak memory.
let queue: Promise<void> = Promise.resolve();
process.on("message", (message: EmbeddingWorkerRequest) => {
  queue = queue.then(() => handle(message));
});
process.on("disconnect", () => {
  ipcClosing = true;
  process.exit(0);
});
