import { appendFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { FileUploadRequest, FileUploadResponse } from "../messages.js";

interface FileUploadStoreOptions {
  paseoHome: string;
  staleUploadTimeoutMs?: number;
}

interface PendingUpload {
  requestId: string;
  id: string;
  attempt: number;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  receivedBytes: number;
  started: boolean;
  staleTimeout: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
}

export class FileUploadStore {
  private static readonly defaultStaleUploadTimeoutMs = 10 * 60 * 1000;

  private readonly paseoHome: string;
  private readonly staleUploadTimeoutMs: number;
  private readonly pending = new Map<string, PendingUpload>();
  // Request ids whose transfer expired: their next frame gets an explicit error instead of
  // silence, so the client fails at once rather than waiting for its RPC timeout.
  private readonly expired = new Map<string, { upload: UploadIdentity; cleanup: Promise<void> }>();

  constructor(options: FileUploadStoreOptions) {
    this.paseoHome = options.paseoHome;
    this.staleUploadTimeoutMs =
      options.staleUploadTimeoutMs ?? FileUploadStore.defaultStaleUploadTimeoutMs;
  }

  beginUpload(request: FileUploadRequest): void {
    this.expired.delete(request.requestId);
    const existingUpload = this.pending.get(request.requestId);
    if (existingUpload) {
      this.clearPendingUpload(existingUpload);
      void existingUpload.queue.then(() => this.removeUploadDirectory(existingUpload));
    }

    const fileName = sanitizeFileName(request.fileName);
    const attempt = existingUpload ? existingUpload.attempt + 1 : 1;
    const id = buildUploadId(request.requestId, attempt);
    const uploadDir = join(this.paseoHome, "uploads", id);
    const upload: PendingUpload = {
      requestId: request.requestId,
      id,
      attempt,
      fileName,
      mimeType: request.mimeType,
      size: request.size,
      path: join(uploadDir, fileName),
      receivedBytes: 0,
      started: false,
      staleTimeout: this.createStaleUploadTimeout(request.requestId),
      queue: Promise.resolve(),
    };
    this.pending.set(request.requestId, upload);
  }

  async receiveFrame(frame: FileTransferFrame): Promise<FileUploadResponse | null> {
    const upload = this.pending.get(frame.requestId);
    if (!upload) {
      const expired = this.expired.get(frame.requestId);
      if (!expired) {
        return null;
      }
      this.expired.delete(frame.requestId);
      await expired.cleanup;
      return buildUploadResponse(
        expired.upload,
        "The upload stopped receiving data and the host dropped it. Send it again.",
      );
    }
    this.refreshStaleUploadTimeout(upload);

    const operation = upload.queue.then(() => this.applyFrame(upload, frame));
    upload.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async applyFrame(
    upload: PendingUpload,
    frame: FileTransferFrame,
  ): Promise<FileUploadResponse | null> {
    if (this.pending.get(upload.requestId) !== upload) {
      return null;
    }

    try {
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        await this.startWriting(upload);
        return null;
      }
      if (frame.opcode === FileTransferOpcode.FileChunk) {
        await this.writeChunk(upload, frame.payload);
        return null;
      }
      return await this.completeUpload(upload);
    } catch (error) {
      await this.removeFailedUpload(upload);
      return buildUploadResponse(upload, getErrorMessage(error));
    }
  }

  private async startWriting(upload: PendingUpload): Promise<void> {
    await mkdir(join(this.paseoHome, "uploads", upload.id), { recursive: true });
    await writeFile(upload.path, new Uint8Array());
    upload.started = true;
  }

  private async writeChunk(upload: PendingUpload, bytes: Uint8Array): Promise<void> {
    if (!upload.started) {
      throw new Error("Upload chunks arrived before file begin.");
    }
    const nextReceivedBytes = upload.receivedBytes + bytes.byteLength;
    if (nextReceivedBytes > upload.size) {
      throw new Error(
        `Upload exceeded declared size: expected ${upload.size}, received ${nextReceivedBytes}.`,
      );
    }
    await appendFile(upload.path, bytes);
    upload.receivedBytes += bytes.byteLength;
  }

  private async completeUpload(upload: PendingUpload): Promise<FileUploadResponse> {
    this.clearPendingUpload(upload);
    if (upload.receivedBytes !== upload.size) {
      await this.removeUploadDirectory(upload);
      return buildUploadResponse(
        upload,
        `Upload size mismatch: expected ${upload.size}, received ${upload.receivedBytes}.`,
      );
    }
    return buildUploadResponse(upload, null);
  }

  private createStaleUploadTimeout(requestId: string): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      this.expireStaleUpload(requestId);
    }, this.staleUploadTimeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private refreshStaleUploadTimeout(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    upload.staleTimeout = this.createStaleUploadTimeout(upload.requestId);
  }

  private expireStaleUpload(requestId: string): void {
    const upload = this.pending.get(requestId);
    if (!upload) {
      return;
    }
    this.clearPendingUpload(upload);
    const cleanup = upload.queue.then(
      () => this.removeUploadDirectory(upload),
      () => this.removeUploadDirectory(upload),
    );
    upload.queue = cleanup.then(
      () => undefined,
      () => undefined,
    );
    this.expired.set(requestId, { upload, cleanup: upload.queue });
    if (this.expired.size > MAX_EXPIRED_TOMBSTONES) {
      const oldest = this.expired.keys().next().value;
      if (oldest !== undefined) this.expired.delete(oldest);
    }
  }

  private clearPendingUpload(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    if (this.pending.get(upload.requestId) === upload) {
      this.pending.delete(upload.requestId);
    }
  }

  private async removeFailedUpload(upload: PendingUpload): Promise<void> {
    this.clearPendingUpload(upload);
    await this.removeUploadDirectory(upload);
  }

  private async removeUploadDirectory(upload: PendingUpload): Promise<void> {
    await rm(join(this.paseoHome, "uploads", upload.id), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

const MAX_EXPIRED_TOMBSTONES = 256;

type UploadIdentity = Pick<
  PendingUpload,
  "requestId" | "id" | "fileName" | "mimeType" | "size" | "path"
>;

function buildUploadResponse(upload: UploadIdentity, error: string | null): FileUploadResponse {
  return {
    type: "file.upload.response",
    payload: {
      requestId: upload.requestId,
      file: error
        ? null
        : {
            type: "uploaded_file",
            id: upload.id,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            size: upload.size,
            path: upload.path,
          },
      error,
    },
  };
}

function sanitizeUploadId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
}

function buildUploadId(requestId: string, attempt: number): string {
  const baseId = `upload_${sanitizeUploadId(requestId)}`;
  return attempt === 1 ? baseId : `${baseId}_${attempt}`;
}

// Most file systems cap a single file name at 255 bytes.
const MAX_FILE_NAME_BYTES = 255;

// Keeps the client's file name, replacing only what cannot appear in a single
// file name on Linux, macOS, or Windows.
function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[\p{Cc}\\/:*?"<>|]/gu, "_")
    .trim();
  return fitFileNameLength(name.length > 0 && name !== "." && name !== ".." ? name : "upload");
}

function fitFileNameLength(name: string): string {
  if (Buffer.byteLength(name) <= MAX_FILE_NAME_BYTES) return name;
  const extension = extname(name);
  const keptExtension = Buffer.byteLength(extension) < MAX_FILE_NAME_BYTES ? extension : "";
  let stem = "";
  for (const char of name.slice(0, name.length - keptExtension.length)) {
    if (Buffer.byteLength(stem + char + keptExtension) > MAX_FILE_NAME_BYTES) break;
    stem += char;
  }
  return stem + keptExtension;
}

/**
 * Marker written into an upload directory once a message references the uploaded file by path
 * (an "Upload file" attachment). The agent may read that path at any later turn, so the age
 * sweep keeps marked uploads. Image uploads are consumed into the message bytes and removed
 * instead (see image-uploads.ts).
 */
export const UPLOAD_ADMITTED_MARKER = ".admitted";

const UPLOAD_ID_PATTERN = /^upload_[A-Za-z0-9._-]+$/;

export function uploadDirectory(input: { paseoHome: string; uploadId: string }): string {
  if (!UPLOAD_ID_PATTERN.test(input.uploadId) || input.uploadId.includes("..")) {
    throw new Error(`Invalid upload id: ${input.uploadId}`);
  }
  return join(input.paseoHome, "uploads", input.uploadId);
}

/** Records that a sent message references these uploaded files, so the sweep keeps them. */
export async function markUploadsAdmitted(input: {
  paseoHome: string;
  uploadIds: readonly string[];
}): Promise<void> {
  await Promise.all(
    input.uploadIds.map(async (uploadId) => {
      let dir: string;
      try {
        dir = uploadDirectory({ paseoHome: input.paseoHome, uploadId });
      } catch {
        return;
      }
      await writeFile(join(dir, UPLOAD_ADMITTED_MARKER), "").catch(() => undefined);
    }),
  );
}

// An upload no message took within this time was abandoned (a failed send, a draft attachment
// that was removed, a client that went away mid-transfer). A draft that holds an uploaded file
// longer than this loses it; a week keeps ordinary drafts safe.
export const ABANDONED_UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function newestModification(dir: string): Promise<number> {
  let newest = (await stat(dir)).mtimeMs;
  for (const entry of await readdir(dir)) {
    const entryStat = await stat(join(dir, entry)).catch(() => null);
    if (entryStat && entryStat.mtimeMs > newest) newest = entryStat.mtimeMs;
  }
  return newest;
}

/** Removes upload directories that no message admitted and that saw no write for `maxAgeMs`. */
export async function sweepAbandonedUploads(input: {
  paseoHome: string;
  maxAgeMs?: number;
  now?: number;
}): Promise<{ removed: string[] }> {
  const root = join(input.paseoHome, "uploads");
  const maxAgeMs = input.maxAgeMs ?? ABANDONED_UPLOAD_MAX_AGE_MS;
  const now = input.now ?? Date.now();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { removed: [] };
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!UPLOAD_ID_PATTERN.test(entry)) continue;
    const dir = join(root, entry);
    try {
      const children = await readdir(dir);
      if (children.includes(UPLOAD_ADMITTED_MARKER)) continue;
      if (now - (await newestModification(dir)) < maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // Not a directory, or it vanished meanwhile.
    }
  }
  return { removed };
}

/** Sweeps abandoned uploads now and then every few hours; returns a stop function. */
export function startUploadSweeper(input: {
  paseoHome: string;
  logger: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}): () => void {
  const run = (): void => {
    void sweepAbandonedUploads({ paseoHome: input.paseoHome }).then(
      ({ removed }) => {
        if (removed.length > 0) {
          input.logger.info({ removed: removed.length }, "Removed abandoned file uploads");
        }
        return undefined;
      },
      (error: unknown) => {
        input.logger.warn({ err: error }, "Failed to sweep abandoned file uploads");
      },
    );
  };
  run();
  const interval = setInterval(run, UPLOAD_SWEEP_INTERVAL_MS);
  interval.unref?.();
  return () => clearInterval(interval);
}
