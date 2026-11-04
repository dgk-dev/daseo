/**
 * IPC between the daemon and the History search embedding worker. The worker
 * is the only process that loads ONNX Runtime and the model (about 700 MB
 * resident once warm), so the daemon's own memory never grows by the model.
 */
export interface EmbeddingWorkerModelConfig {
  modelPath: string;
  tokenizerPath: string;
  tokenizerConfigPath: string;
  maxTokens: number;
}

export interface EmbeddingWorkerEmbedRequest {
  type: "embed";
  requestId: string;
  model: EmbeddingWorkerModelConfig;
  /** Prepended to every text (`query: ` / `passage: ` for e5). */
  prefix: string;
  texts: string[];
}

export type EmbeddingWorkerRequest = EmbeddingWorkerEmbedRequest;

export type EmbeddingWorkerResponse =
  | { type: "response"; requestId: string; ok: true; vectors: Float32Array[] }
  | { type: "response"; requestId: string; ok: false; error: string };
