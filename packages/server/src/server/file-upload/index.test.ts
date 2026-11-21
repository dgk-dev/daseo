import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  FileUploadStore,
  markUploadsAdmitted,
  readUploadThumbnail,
  sweepAbandonedUploads,
  UPLOAD_ADMITTED_MARKER,
  UPLOAD_SWEEP_BASELINE,
  UPLOAD_THUMBNAIL_FILE,
  writeUploadThumbnail,
} from "./index.js";
import { readImageUploads } from "./image-uploads.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(now: number, days: number): number {
  return (now - days * DAY_MS) / 1000;
}

function mkdirUploads(paseoHome: string): string {
  mkdirSync(join(paseoHome, "uploads"), { recursive: true });
  return paseoHome;
}

function makeUpload(paseoHome: string, id: string, mtimeSeconds: number): void {
  const dir = join(paseoHome, "uploads", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "file.bin"), "x");
  utimesSync(join(dir, "file.bin"), mtimeSeconds, mtimeSeconds);
  utimesSync(dir, mtimeSeconds, mtimeSeconds);
}

const tempDirs: string[] = [];

describe("file uploads", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores chunked upload bytes and returns an uploaded-file attachment", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-upload"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", "hello"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", " world"))).resolves.toBeNull();

    const path = join(paseoHome, "uploads", "upload_req-upload", "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-upload"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-upload",
        file: {
          type: "uploaded_file",
          id: "upload_req-upload",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  it("keeps the original file name for non-ASCII and punctuated names", async () => {
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    for (const fileName of [
      "2026年9月绩效计划表.xlsx",
      "테스트 파일 (1).xlsx",
      "résumé [final] & notes, v2.pdf",
      "cafe\u0301 हिंदी.txt",
    ]) {
      const file = await uploadNamed(uploads, fileName);
      expect(file?.fileName).toBe(fileName);
      expect(basename(file!.path)).toBe(fileName);
      expect(readFileSync(file!.path, "utf8")).toBe("hello world");
    }
  });

  it("replaces path separators, control characters, and characters Windows rejects", async () => {
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    await expect(uploadNamed(uploads, "../../etc/passwd")).resolves.toMatchObject({
      fileName: "passwd",
    });
    const backslashed = await uploadNamed(uploads, "dir\\name.txt");
    expect(backslashed?.fileName).not.toContain("\\");
    expect(backslashed?.fileName).toMatch(/name\.txt$/);
    await expect(uploadNamed(uploads, 'a<b>:"c|?*.txt')).resolves.toMatchObject({
      fileName: "a_b___c___.txt",
    });
    await expect(uploadNamed(uploads, "line\nbreak.txt")).resolves.toMatchObject({
      fileName: "line_break.txt",
    });
  });

  it("shortens a long non-ASCII name to the file system limit and keeps its extension", async () => {
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome() });

    const file = await uploadNamed(uploads, `${"绩".repeat(100)}.xlsx`);

    expect(file?.fileName).toBe(`${"绩".repeat(83)}.xlsx`);
    expect(Buffer.byteLength(file!.fileName)).toBeLessThanOrEqual(255);
    expect(readFileSync(file!.path, "utf8")).toBe("hello world");
  });

  it("rejects chunks beyond the declared size and removes the partial file", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-overflow",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-overflow"))).resolves.toBeNull();

    const uploadDir = join(paseoHome, "uploads", "upload_req-overflow");
    const path = join(uploadDir, "notes.txt");
    await expect(uploads.receiveFrame(uploadChunk("req-overflow", "hello!"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-overflow",
        file: null,
        error: "Upload exceeded declared size: expected 5, received 6.",
      },
    });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(uploadDir)).toBe(false);
  });

  it("preserves chunk order when frames arrive before earlier disk writes finish", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-queued",
    });

    const results = await Promise.all([
      uploads.receiveFrame(uploadBegins("req-queued")),
      uploads.receiveFrame(uploadChunk("req-queued", "hello")),
      uploads.receiveFrame(uploadChunk("req-queued", " world")),
      uploads.receiveFrame(uploadEnds("req-queued")),
    ]);

    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]?.payload.error).toBeNull();
    expect(readFileSync(join(paseoHome, "uploads", "upload_req-queued", "notes.txt"), "utf8")).toBe(
      "hello world",
    );
  });

  it("replaces duplicate upload starts without letting the old stale timeout evict the replacement", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "old.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "old"))).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(25);
    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "new.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await vi.advanceTimersByTimeAsync(30);

    const path = join(paseoHome, "uploads", "upload_req-duplicate_2", "new.txt");
    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "new"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadEnds("req-duplicate"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-duplicate",
        file: {
          type: "uploaded_file",
          id: "upload_req-duplicate_2",
          fileName: "new.txt",
          mimeType: "text/plain",
          size: 3,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("keeps an active upload alive beyond the initial stale timeout", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-slow-active",
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(uploads.receiveFrame(uploadBegins("req-slow-active"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(uploads.receiveFrame(uploadChunk("req-slow-active", "hello"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(
      uploads.receiveFrame(uploadChunk("req-slow-active", " world")),
    ).resolves.toBeNull();

    const path = join(paseoHome, "uploads", "upload_req-slow-active", "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-slow-active"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-slow-active",
        file: {
          type: "uploaded_file",
          id: "upload_req-slow-active",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });
});

describe("stale and abandoned uploads", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers the next frame of an expired transfer with an error instead of silence", async () => {
    vi.useFakeTimers();
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });
    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-stalled",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-stalled"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-stalled", "hello"))).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(60);

    const response = await uploads.receiveFrame(uploadChunk("req-stalled", " world"));
    expect(response).toMatchObject({
      type: "file.upload.response",
      payload: { requestId: "req-stalled", file: null },
    });
    expect(response?.payload.error).toMatch(/Send it again/);
    expect(existsSync(join(paseoHome, "uploads", "upload_req-stalled"))).toBe(false);
    // One answer per expired transfer; the rest of its frames are dropped.
    await expect(uploads.receiveFrame(uploadEnds("req-stalled"))).resolves.toBeNull();
  });

  it("keeps every upload that predates the first sweep, on that sweep and on later ones", async () => {
    const paseoHome = makePaseoHome();
    const now = Date.now();
    makeUpload(paseoHome, "upload_legacy_pdf", daysAgo(now, 30));

    await expect(sweepAbandonedUploads({ paseoHome, now })).resolves.toEqual({ removed: [] });
    expect(existsSync(join(paseoHome, "uploads", UPLOAD_SWEEP_BASELINE))).toBe(true);
    await expect(sweepAbandonedUploads({ paseoHome, now: now + 30 * DAY_MS })).resolves.toEqual({
      removed: [],
    });
    expect(existsSync(join(paseoHome, "uploads", "upload_legacy_pdf", "file.bin"))).toBe(true);
  });

  it("after the baseline, sweeps unadmitted uploads older than the age limit and keeps admitted or recent ones", async () => {
    const paseoHome = makePaseoHome();
    const now = Date.now();
    await sweepAbandonedUploads({ paseoHome: mkdirUploads(paseoHome), now });
    makeUpload(paseoHome, "upload_old", daysAgo(now, 8));
    makeUpload(paseoHome, "upload_old_admitted", daysAgo(now, 8));
    makeUpload(paseoHome, "upload_recent", now / 1000);
    await markUploadsAdmitted({ paseoHome, uploadIds: ["upload_old_admitted", "../escape"] });
    utimesSync(join(paseoHome, "uploads", "upload_old_admitted"), daysAgo(now, 8), daysAgo(now, 8));

    const { removed } = await sweepAbandonedUploads({ paseoHome, now });

    expect(removed).toEqual(["upload_old"]);
    expect(existsSync(join(paseoHome, "uploads", "upload_old"))).toBe(false);
    expect(
      existsSync(join(paseoHome, "uploads", "upload_old_admitted", UPLOAD_ADMITTED_MARKER)),
    ).toBe(true);
    expect(existsSync(join(paseoHome, "uploads", "upload_recent"))).toBe(true);
  });

  it("sweeping a home without uploads does nothing", async () => {
    await expect(sweepAbandonedUploads({ paseoHome: makePaseoHome() })).resolves.toEqual({
      removed: [],
    });
  });
});

let uploadCount = 0;

async function uploadNamed(uploads: FileUploadStore, fileName: string) {
  const requestId = `req-named-${uploadCount++}`;
  uploads.beginUpload({
    type: "file.upload.request",
    fileName,
    mimeType: "text/plain",
    size: 11,
    modifiedAt: "2026-05-02T00:00:00.000Z",
    requestId,
  });
  await uploads.receiveFrame(uploadBegins(requestId));
  await uploads.receiveFrame(uploadChunk(requestId, "hello world"));
  const response = await uploads.receiveFrame(uploadEnds(requestId));
  expect(response?.payload.error).toBeNull();
  return response?.payload.file;
}

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-upload-test-")));
  tempDirs.push(root);
  return root;
}

function uploadBegins(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "text/plain",
        size: 11,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
        fileName: "notes.txt",
      },
    }),
  );
}

function uploadChunk(requestId: string, text: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId,
      payload: new TextEncoder().encode(text),
    }),
  );
}

function uploadEnds(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId,
    }),
  );
}

function decodeUploadFrame(bytes: Uint8Array): FileTransferFrame {
  const frame = decodeFileTransferFrame(bytes);
  if (!frame) {
    throw new Error("Expected file transfer frame");
  }
  return frame;
}

describe("upload thumbnails (delta 139)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores a thumbnail next to its upload, out of the image read, and removes it with the upload", async () => {
    const paseoHome = makePaseoHome();
    const now = Date.now();
    await sweepAbandonedUploads({ paseoHome: mkdirUploads(paseoHome), now });
    makeUpload(paseoHome, "upload_photo", daysAgo(now, 8));
    const thumbnail = { data: "AAAA", mimeType: "image/jpeg", width: 4, height: 3 };

    await writeUploadThumbnail({ paseoHome, uploadId: "upload_photo", thumbnail });
    await expect(readUploadThumbnail({ paseoHome, uploadId: "upload_photo" })).resolves.toEqual(
      thumbnail,
    );
    await expect(
      readImageUploads({
        paseoHome,
        uploads: [{ uploadId: "upload_photo", mimeType: "image/png" }],
      }),
    ).resolves.toEqual([{ data: "eA==", mimeType: "image/png" }]);

    utimesSync(
      join(paseoHome, "uploads", "upload_photo", UPLOAD_THUMBNAIL_FILE),
      daysAgo(now, 8),
      daysAgo(now, 8),
    );
    utimesSync(join(paseoHome, "uploads", "upload_photo"), daysAgo(now, 8), daysAgo(now, 8));
    await expect(sweepAbandonedUploads({ paseoHome, now })).resolves.toEqual({
      removed: ["upload_photo"],
    });
    await expect(readUploadThumbnail({ paseoHome, uploadId: "upload_photo" })).resolves.toBeNull();
  });

  it("refuses an oversized thumbnail or one for a missing upload", async () => {
    const paseoHome = makePaseoHome();
    makeUpload(paseoHome, "upload_photo", Date.now() / 1000);
    await expect(
      writeUploadThumbnail({
        paseoHome,
        uploadId: "upload_photo",
        thumbnail: { data: "A".repeat(200 * 1024), mimeType: "image/jpeg", width: 4, height: 3 },
      }),
    ).rejects.toThrow("larger than a thumbnail");
    await expect(
      writeUploadThumbnail({
        paseoHome,
        uploadId: "upload_gone",
        thumbnail: { data: "AAAA", mimeType: "image/jpeg", width: 4, height: 3 },
      }),
    ).rejects.toThrow("no longer on the host");
  });
});
