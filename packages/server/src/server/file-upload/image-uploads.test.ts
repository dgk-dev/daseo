import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { mergeInlineImages, readImageUploads } from "./image-uploads.js";

describe("readImageUploads", () => {
  let paseoHome: string;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "image-uploads-"));
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("reads an uploaded image as inline base64", async () => {
    await mkdir(join(paseoHome, "uploads", "upload_abc"), { recursive: true });
    await writeFile(join(paseoHome, "uploads", "upload_abc", "photo.jpg"), "hello");

    const images = await readImageUploads({
      paseoHome,
      uploads: [{ uploadId: "upload_abc", mimeType: "image/jpeg" }],
    });

    expect(images).toEqual([{ data: "aGVsbG8=", mimeType: "image/jpeg" }]);
  });

  test("rejects ids that could leave the uploads directory", async () => {
    await expect(
      readImageUploads({ paseoHome, uploads: [{ uploadId: "../secrets", mimeType: "image/png" }] }),
    ).rejects.toThrow("Invalid image upload id");
    await expect(
      readImageUploads({ paseoHome, uploads: [{ uploadId: "upload_..", mimeType: "image/png" }] }),
    ).rejects.toThrow("Invalid image upload id");
  });

  test("rejects non-image uploads and missing uploads", async () => {
    await expect(
      readImageUploads({ paseoHome, uploads: [{ uploadId: "upload_x", mimeType: "text/plain" }] }),
    ).rejects.toThrow("is not an image");
    await expect(
      readImageUploads({
        paseoHome,
        uploads: [{ uploadId: "upload_gone", mimeType: "image/png" }],
      }),
    ).rejects.toThrow("no longer on the host");
  });

  test("appends uploaded images after inline ones", () => {
    expect(
      mergeInlineImages(
        [{ data: "a", mimeType: "image/png" }],
        [{ data: "b", mimeType: "image/jpeg" }],
      ),
    ).toEqual([
      { data: "a", mimeType: "image/png" },
      { data: "b", mimeType: "image/jpeg" },
    ]);
    expect(mergeInlineImages(undefined, [])).toBeUndefined();
  });
});
