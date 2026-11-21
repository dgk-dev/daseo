import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComposerDraft, ComposerDraftAttachment } from "@getpaseo/protocol/messages";
import { sweepAbandonedUploads, UPLOAD_DRAFT_MARKER } from "../file-upload/index.js";
import { consumeImageUploads } from "../file-upload/image-uploads.js";
import { ComposerDraftStore } from "./composer-draft-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const logger = pino({ level: "silent" });

function imageRef(uploadId: string): ComposerDraftAttachment {
  return {
    id: `att-${uploadId}`,
    kind: "image",
    uploadId,
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    size: 5,
    thumbnail: { mimeType: "image/jpeg", width: 4, height: 3 },
  };
}

function makeUpload(paseoHome: string, id: string, mtimeMs: number): void {
  const dir = join(paseoHome, "uploads", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "photo.jpg"), "hello");
  ageUpload(paseoHome, id, mtimeMs);
}

function ageUpload(paseoHome: string, id: string, mtimeMs: number): void {
  const dir = join(paseoHome, "uploads", id);
  const seconds = mtimeMs / 1000;
  for (const entry of readdirSync(dir)) utimesSync(join(dir, entry), seconds, seconds);
  utimesSync(dir, seconds, seconds);
}

describe("ComposerDraftStore", () => {
  let paseoHome: string;
  let filePath: string;
  let clock: number;

  function createStore(): ComposerDraftStore {
    return new ComposerDraftStore({ filePath, paseoHome, logger, now: () => clock });
  }

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "composer-drafts-"));
    filePath = join(paseoHome, "composer-drafts.json");
    clock = 1_000_000;
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  it("stores a draft with a rising revision and notifies listeners with the writer", async () => {
    const store = createStore();
    const seen: Array<{ draft: ComposerDraft; origin: object | null }> = [];
    store.onChange((draft, origin) => seen.push({ draft, origin }));
    const writer = {};

    const first = await store.set(
      { agentId: "a1", text: "hel", attachments: [], clientId: "mac" },
      writer,
    );
    clock += 10;
    const second = await store.set(
      { agentId: "a1", text: "hello", attachments: [], clientId: "phone" },
      null,
    );

    expect(first).toMatchObject({
      revision: 1,
      text: "hel",
      clientId: "mac",
      updatedAt: 1_000_000,
    });
    expect(second).toMatchObject({ revision: 2, text: "hello", clientId: "phone" });
    expect(seen.map((entry) => [entry.draft.revision, entry.origin])).toEqual([
      [1, writer],
      [2, null],
    ]);
    await expect(store.list()).resolves.toEqual([second]);
    await expect(store.list(["missing", "a1"])).resolves.toEqual([second]);
  });

  it("clears only the revision that was sent; text written since survives", async () => {
    const store = createStore();
    const sent = await store.set(
      { agentId: "a1", text: "sent", attachments: [], clientId: "phone" },
      null,
    );
    const newer = await store.set(
      { agentId: "a1", text: "typed during the send", attachments: [], clientId: "mac" },
      null,
    );

    await expect(
      store.clear({ agentId: "a1", clientId: "phone", revision: sent.revision }, null),
    ).resolves.toEqual({ draft: newer, cleared: false });

    const result = await store.clear(
      { agentId: "a1", clientId: "mac", revision: newer.revision },
      null,
    );
    expect(result.cleared).toBe(true);
    expect(result.draft).toMatchObject({ text: "", attachments: [], revision: newer.revision + 1 });
    // A cleared draft keeps its revision, so an older clear stays stale.
    await expect(store.get("a1")).resolves.toMatchObject({ revision: newer.revision + 1 });
  });

  it("survives a restart and drops month-old cleared drafts", async () => {
    const store = createStore();
    await store.set({ agentId: "kept", text: "keep me", attachments: [], clientId: "mac" }, null);
    const old = await store.set(
      { agentId: "old", text: "x", attachments: [], clientId: "mac" },
      null,
    );
    await store.clear({ agentId: "old", clientId: "mac", revision: old.revision }, null);
    await store.set({ agentId: "recent", text: "y", attachments: [], clientId: "mac" }, null);

    clock += 31 * DAY_MS;
    const recent = await store.get("recent");
    await store.clear({ agentId: "recent", clientId: "mac", revision: recent!.revision }, null);

    const reloaded = createStore();
    const ids = (await reloaded.list()).map((draft) => draft.agentId).sort();
    expect(ids).toEqual(["kept", "recent"]);
    await expect(reloaded.get("kept")).resolves.toMatchObject({ text: "keep me", revision: 1 });
  });

  it("copies an unreadable file aside and starts empty", async () => {
    await writeFile(filePath, "{not json");
    const store = createStore();
    await expect(store.list()).resolves.toEqual([]);
    expect(readdirSync(paseoHome).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("forgets a deleted agent's draft and its upload pins", async () => {
    const store = createStore();
    await store.set(
      { agentId: "a1", text: "", attachments: [imageRef("upload_one")], clientId: "mac" },
      null,
    );
    await expect(store.pinnedUploadIds()).resolves.toEqual(new Set(["upload_one"]));

    await store.remove("a1");

    await expect(store.get("a1")).resolves.toBeNull();
    await expect(store.pinnedUploadIds()).resolves.toEqual(new Set());
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { drafts: object };
    expect(persisted.drafts).toEqual({});
  });

  it("keeps an upload a draft references past the age limit; unpinned, the age sweep removes it", async () => {
    const store = createStore();
    const now = Date.now();
    mkdirSync(join(paseoHome, "uploads"), { recursive: true });
    await sweepAbandonedUploads({ paseoHome, now }); // first sweep writes the baseline
    makeUpload(paseoHome, "upload_photo", now);

    const draft = await store.set(
      { agentId: "a1", text: "look", attachments: [imageRef("upload_photo")], clientId: "phone" },
      null,
    );
    expect(existsSync(join(paseoHome, "uploads", "upload_photo", UPLOAD_DRAFT_MARKER))).toBe(true);
    ageUpload(paseoHome, "upload_photo", now - 8 * DAY_MS);

    await expect(
      sweepAbandonedUploads({ paseoHome, now, pinnedUploadIds: await store.pinnedUploadIds() }),
    ).resolves.toEqual({ removed: [] });
    expect(existsSync(join(paseoHome, "uploads", "upload_photo", "photo.jpg"))).toBe(true);

    // The attachment is removed from the draft: no longer pinned, and its age restarts now, so the
    // ordinary 7-day rule removes it a week later.
    await store.set({ agentId: "a1", text: "look", attachments: [], clientId: "phone" }, null);
    expect(draft.revision).toBe(1);
    const unpinned = await store.pinnedUploadIds();
    expect(unpinned).toEqual(new Set());
    await expect(
      sweepAbandonedUploads({ paseoHome, now: Date.now(), pinnedUploadIds: unpinned }),
    ).resolves.toEqual({ removed: [] });
    await expect(
      sweepAbandonedUploads({ paseoHome, now: Date.now() + 8 * DAY_MS, pinnedUploadIds: unpinned }),
    ).resolves.toEqual({ removed: ["upload_photo"] });
    expect(existsSync(join(paseoHome, "uploads", "upload_photo"))).toBe(false);
  });

  it("a cleared draft restarts the age of its uploads, so a queued send still finds them", async () => {
    const store = createStore();
    const now = Date.now();
    mkdirSync(join(paseoHome, "uploads"), { recursive: true });
    await sweepAbandonedUploads({ paseoHome, now });
    makeUpload(paseoHome, "upload_queued", now);
    makeUpload(paseoHome, "upload_removed", now);
    const draft = await store.set(
      {
        agentId: "a1",
        text: "queued",
        attachments: [imageRef("upload_queued"), imageRef("upload_removed")],
        clientId: "phone",
      },
      null,
    );
    ageUpload(paseoHome, "upload_queued", now - 8 * DAY_MS);
    ageUpload(paseoHome, "upload_removed", now - 8 * DAY_MS);

    // One attachment removed from the draft, then the draft cleared by the send that queued it.
    const edited = await store.set(
      {
        agentId: "a1",
        text: "queued",
        attachments: [imageRef("upload_queued")],
        clientId: "phone",
      },
      null,
    );
    await store.clear({ agentId: "a1", clientId: "phone", revision: edited.revision }, null);
    expect(draft.revision).toBe(1);
    await expect(store.pinnedUploadIds()).resolves.toEqual(new Set());

    // Unpinned, but both were just refreshed: the sweep keeps them for another 7 days.
    await expect(sweepAbandonedUploads({ paseoHome, now: Date.now() })).resolves.toEqual({
      removed: [],
    });
    await expect(
      consumeImageUploads({
        paseoHome,
        uploads: [{ uploadId: "upload_queued", mimeType: "image/jpeg" }],
      }),
    ).resolves.toHaveLength(1);
    const later = await sweepAbandonedUploads({ paseoHome, now: Date.now() + 8 * DAY_MS });
    expect(later.removed.sort()).toEqual(["upload_queued", "upload_removed"]);
  });

  it("an image upload a draft referenced is read at send but not removed", async () => {
    const store = createStore();
    makeUpload(paseoHome, "upload_drafted", Date.now());
    makeUpload(paseoHome, "upload_plain", Date.now());
    await store.set(
      { agentId: "a1", text: "", attachments: [imageRef("upload_drafted")], clientId: "phone" },
      null,
    );

    const images = await consumeImageUploads({
      paseoHome,
      uploads: [
        { uploadId: "upload_drafted", mimeType: "image/jpeg" },
        { uploadId: "upload_plain", mimeType: "image/jpeg" },
      ],
    });

    expect(images).toHaveLength(2);
    expect(existsSync(join(paseoHome, "uploads", "upload_drafted", "photo.jpg"))).toBe(true);
    expect(existsSync(join(paseoHome, "uploads", "upload_plain"))).toBe(false);
  });
});
