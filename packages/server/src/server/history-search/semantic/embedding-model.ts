import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * The local embedding model for History search: multilingual-e5-small,
 * 8-bit quantized ONNX (384 dimensions). It reads Korean and English, runs on
 * the CPU in a few milliseconds per query, and needs no key: no transcript
 * leaves the Mac. Files are pinned to one Hub revision and verified by sha256,
 * so a re-upload upstream can never change what the index was built with.
 */
export interface EmbeddingModelFile {
  /** Path inside the model directory and inside the Hub repository. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface EmbeddingModelSpec {
  id: string;
  repository: string;
  revision: string;
  dimensions: number;
  /** e5 was trained with these prefixes; leaving them off costs recall. */
  queryPrefix: string;
  passagePrefix: string;
  maxTokens: number;
  files: {
    model: EmbeddingModelFile;
    tokenizer: EmbeddingModelFile;
    tokenizerConfig: EmbeddingModelFile;
  };
}

export const HISTORY_EMBEDDING_MODEL: EmbeddingModelSpec = {
  id: "multilingual-e5-small-q8",
  repository: "Xenova/multilingual-e5-small",
  revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  dimensions: 384,
  queryPrefix: "query: ",
  passagePrefix: "passage: ",
  maxTokens: 512,
  files: {
    model: {
      path: "onnx/model_quantized.onnx",
      bytes: 118_308_185,
      sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    },
    tokenizer: {
      path: "tokenizer.json",
      bytes: 17_082_730,
      sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    tokenizerConfig: {
      path: "tokenizer_config.json",
      bytes: 443,
      sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
  },
};

export function embeddingModelFiles(spec: EmbeddingModelSpec): EmbeddingModelFile[] {
  return [spec.files.model, spec.files.tokenizer, spec.files.tokenizerConfig];
}

export function embeddingModelTotalBytes(spec: EmbeddingModelSpec): number {
  return embeddingModelFiles(spec).reduce((total, file) => total + file.bytes, 0);
}

export function embeddingModelDirectory(modelsDir: string, spec: EmbeddingModelSpec): string {
  return path.join(modelsDir, spec.id);
}

function fileUrl(spec: EmbeddingModelSpec, file: EmbeddingModelFile): string {
  return `https://huggingface.co/${spec.repository}/resolve/${spec.revision}/${file.path}`;
}

async function hasExpectedSize(filePath: string, bytes: number): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size === bytes;
  } catch {
    return false;
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

/** True when every file is present at its pinned size (no hashing; cheap). */
export async function isEmbeddingModelPresent(input: {
  modelsDir: string;
  spec: EmbeddingModelSpec;
}): Promise<boolean> {
  const directory = embeddingModelDirectory(input.modelsDir, input.spec);
  const checks = await Promise.all(
    embeddingModelFiles(input.spec).map((file) =>
      hasExpectedSize(path.join(directory, file.path), file.bytes),
    ),
  );
  return checks.every(Boolean);
}

export class EmbeddingModelDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingModelDownloadError";
  }
}

export interface EnsureEmbeddingModelOptions {
  modelsDir: string;
  spec: EmbeddingModelSpec;
  /** Bytes of the whole model now on disk, called as a download streams. */
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Downloads whatever is missing into `<modelsDir>/<id>/`, each file through a
 * temporary name and renamed only after its sha256 matches. Returns the model
 * directory.
 */
export async function ensureEmbeddingModel(options: EnsureEmbeddingModelOptions): Promise<string> {
  const { spec, modelsDir } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const directory = embeddingModelDirectory(modelsDir, spec);
  const totalBytes = embeddingModelTotalBytes(spec);
  const files = embeddingModelFiles(spec);

  let completedBytes = 0;
  const missing: EmbeddingModelFile[] = [];
  for (const file of files) {
    if (await hasExpectedSize(path.join(directory, file.path), file.bytes)) {
      completedBytes += file.bytes;
    } else {
      missing.push(file);
    }
  }
  options.onProgress?.(completedBytes, totalBytes);

  for (const file of missing) {
    const target = path.join(directory, file.path);
    const temporary = `${target}.download-${process.pid}`;
    await mkdir(path.dirname(target), { recursive: true });
    const url = fileUrl(spec, file);
    const response = await fetchImpl(url, { signal: options.signal });
    if (!response.ok || !response.body) {
      throw new EmbeddingModelDownloadError(
        `Download of ${file.path} failed: HTTP ${response.status} ${response.statusText}`,
      );
    }
    const hash = createHash("sha256");
    let fileBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        fileBytes += chunk.length;
        options.onProgress?.(completedBytes + fileBytes, totalBytes);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(temporary),
      );
      const digest = hash.digest("hex");
      if (fileBytes !== file.bytes || digest !== file.sha256) {
        throw new EmbeddingModelDownloadError(
          `Downloaded ${file.path} does not match its pinned hash (${fileBytes} bytes, sha256 ${digest})`,
        );
      }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    completedBytes += file.bytes;
  }
  return directory;
}

/** Full sha256 verification of an installed model, for tests and diagnostics. */
export async function verifyEmbeddingModel(input: {
  modelsDir: string;
  spec: EmbeddingModelSpec;
}): Promise<boolean> {
  const directory = embeddingModelDirectory(input.modelsDir, input.spec);
  for (const file of embeddingModelFiles(input.spec)) {
    const filePath = path.join(directory, file.path);
    if (!(await hasExpectedSize(filePath, file.bytes))) return false;
    if ((await sha256OfFile(filePath)) !== file.sha256) return false;
  }
  return true;
}
