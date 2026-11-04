import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type pino from "pino";
import type {
  EmbeddingWorkerModelConfig,
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
} from "./embedding-worker-protocol.js";

/**
 * Owns the embedding worker process: started on the first request, stopped
 * after `idleTtlMs` without one. Follows the local speech worker
 * (`speech/providers/local/worker-client.ts`), which runs native ONNX code out
 * of the daemon process for the same reason.
 */

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const STDERR_TAIL_MAX_CHARS = 4000;

export interface EmbeddingWorkerProcess {
  connected: boolean;
  killed: boolean;
  pid?: number;
  stderr?: Readable | null;
  send(message: EmbeddingWorkerRequest, callback: (error: Error | null) => void): boolean;
  disconnect(): void;
  kill(): boolean;
  on(event: "message", listener: (message: EmbeddingWorkerResponse) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PendingRequest {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface EmbeddingWorkerClientOptions {
  model: EmbeddingWorkerModelConfig;
  logger: pino.Logger;
  idleTtlMs?: number;
  forkWorker?: () => EmbeddingWorkerProcess;
}

function resolveWorkerUrl(): URL {
  const currentUrl = import.meta.url;
  return new URL(
    currentUrl.endsWith(".ts") ? "./embedding-worker-process.ts" : "./embedding-worker-process.js",
    currentUrl,
  );
}

function resolveWorkerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) return [];
  const loaderUrl = new URL("../../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

function forkEmbeddingWorker(): EmbeddingWorkerProcess {
  return fork(fileURLToPath(resolveWorkerUrl()), [], {
    env: process.env,
    execArgv: resolveWorkerExecArgv(),
    // Float32Array results cross the pipe as typed arrays, not JSON.
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  }) as EmbeddingWorkerProcess;
}

export class EmbeddingWorkerClient {
  private readonly model: EmbeddingWorkerModelConfig;
  private readonly logger: pino.Logger;
  private readonly idleTtlMs: number;
  private readonly forkWorker: () => EmbeddingWorkerProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private worker: EmbeddingWorkerProcess | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrTail = "";
  private readonly intentionalCloses = new WeakSet<EmbeddingWorkerProcess>();

  constructor(options: EmbeddingWorkerClientOptions) {
    this.model = options.model;
    this.logger = options.logger.child({ component: "history-embedding-worker" });
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.forkWorker = options.forkWorker ?? forkEmbeddingWorker;
  }

  /** True while a worker process is alive. */
  get isRunning(): boolean {
    return this.worker !== null;
  }

  embed(input: { prefix: string; texts: string[]; timeoutMs: number }): Promise<Float32Array[]> {
    if (input.texts.length === 0) return Promise.resolve([]);
    const worker = this.ensureWorker();
    const requestId = randomUUID();
    this.clearIdleTimer();
    return new Promise<Float32Array[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        this.scheduleIdleShutdown();
        reject(new Error(`Embedding worker did not answer within ${input.timeoutMs} ms`));
      }, input.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      worker.send(
        {
          type: "embed",
          requestId,
          model: this.model,
          prefix: input.prefix,
          texts: input.texts,
        },
        (error) => {
          if (!error) return;
          this.settle(requestId, { ok: false, error: error.message });
        },
      );
    });
  }

  shutdown(): void {
    this.clearIdleTimer();
    this.rejectAll(new Error("Embedding worker shut down"));
    const worker = this.worker;
    this.worker = null;
    if (!worker || worker.killed) return;
    this.intentionalCloses.add(worker);
    try {
      worker.disconnect();
    } catch {
      // Already disconnected.
    }
    try {
      worker.kill();
    } catch {
      // Already gone.
    }
  }

  private ensureWorker(): EmbeddingWorkerProcess {
    if (this.worker && !this.worker.killed && this.worker.connected) return this.worker;
    const worker = this.forkWorker();
    this.worker = worker;
    this.stderrTail = "";
    this.logger.info({ workerPid: worker.pid ?? null }, "History embedding worker spawned");
    worker.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_MAX_CHARS);
    });
    worker.on("message", (message) => {
      if (message.type !== "response") return;
      this.settle(
        message.requestId,
        message.ok ? { ok: true, vectors: message.vectors } : { ok: false, error: message.error },
      );
    });
    worker.on("close", (code, signal) => this.handleExit(worker, code, signal));
    return worker;
  }

  private settle(
    requestId: string,
    result: { ok: true; vectors: Float32Array[] } | { ok: false; error: string },
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    this.scheduleIdleShutdown();
    if (result.ok) pending.resolve(result.vectors);
    else pending.reject(new Error(result.error));
  }

  private handleExit(
    worker: EmbeddingWorkerProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const intentional = this.intentionalCloses.has(worker);
    this.intentionalCloses.delete(worker);
    if (this.worker !== worker) return;
    this.worker = null;
    this.clearIdleTimer();
    if (intentional) return;
    const stderrTail = this.stderrTail.trim();
    this.logger.warn(
      { code, signal, stderrTail: stderrTail || null },
      "History embedding worker exited",
    );
    this.rejectAll(
      new Error(
        `Embedding worker exited (code ${code ?? "none"}, signal ${signal ?? "none"})${
          stderrTail ? `: ${stderrTail.slice(-500)}` : ""
        }`,
      ),
    );
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  private scheduleIdleShutdown(): void {
    if (!this.worker || this.pending.size > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) {
        this.logger.info("History embedding worker stopped after idle");
        this.shutdown();
      }
    }, this.idleTtlMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
