import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import sharp from "sharp";
import {
  buildBrandOutputs,
  generateDaseoBrandAssets,
  generatedBrandOutputMatches,
} from "../../../scripts/generate-daseo-brand-assets.mjs";

const APP_ICON = "packages/app/assets/images/icon.png";
const DARK_FAVICON = "packages/app/assets/images/favicon-dark.png";
const LIGHT_FAVICON = "packages/app/assets/images/favicon-light.png";
const GENERATED_MODULE = "packages/app/src/components/icons/daseo-logo-path.generated.ts";
const MANIFEST = "packages/app/assets/brand/generated-assets.json";
const ICNS = "packages/desktop/assets/icon.icns";
const ICO = "packages/desktop/assets/icon.ico";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function listManagedBrandFiles() {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const directories = [
    "packages/app/assets/images",
    "packages/app/public",
    "packages/desktop/assets",
  ];
  const files = [];
  for (const directory of directories) {
    const entries = await readdir(path.join(repoRoot, directory), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/[.](?:icns|ico|png|svg)$/.test(entry.name)) continue;
      if (directory === "packages/app/public" && !/(?:apple-touch|pwa-icon)/.test(entry.name)) {
        continue;
      }
      files.push(`${directory}/${entry.name}`);
    }
  }
  return files.sort();
}

describe("Daseo brand asset SSOT", () => {
  test("derives runtime, web, Android, macOS, and Windows assets from one mark", async () => {
    const outputs = await buildBrandOutputs();

    expect(outputs.has(GENERATED_MODULE)).toBe(true);
    expect(outputs.has(APP_ICON)).toBe(true);
    expect(outputs.has("packages/app/assets/images/android-icon-foreground.png")).toBe(true);
    expect(outputs.has("packages/app/assets/images/notification-icon.png")).toBe(true);
    expect(outputs.has("packages/app/public/pwa-icon-512.png")).toBe(true);
    expect(outputs.has(ICNS)).toBe(true);
    expect(outputs.has(ICO)).toBe(true);

    const appIcon = outputs.get(APP_ICON);
    const metadata = await sharp(appIcon).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 1024, height: 1024 });
    expect(outputs.get(DARK_FAVICON)).toEqual(outputs.get(LIGHT_FAVICON));
    expect(outputs.get(ICNS).subarray(0, 4).toString("ascii")).toBe("icns");
    expect(outputs.get(ICO).readUInt16LE(2)).toBe(1);
    expect(outputs.get(ICO).readUInt16LE(4)).toBe(6);
  });

  test("does not leave manually managed brand copies beside generated assets", async () => {
    const outputs = await buildBrandOutputs();
    const generatedAssetFiles = [...outputs.keys()]
      .filter((file) => /[.](?:icns|ico|png|svg)$/.test(file))
      .sort();

    expect(await listManagedBrandFiles()).toEqual(generatedAssetFiles);
  });

  test("records every generated derivative in the checked-in manifest", async () => {
    const outputs = await buildBrandOutputs();
    const manifest = JSON.parse(outputs.get(MANIFEST));
    const generatedEntries = [...outputs.entries()].filter(([file]) => file !== MANIFEST);

    expect(manifest.source).toBe("packages/app/assets/brand/daseo-mark.svg");
    expect(Object.keys(manifest.generated)).toHaveLength(generatedEntries.length);
    for (const [file, content] of generatedEntries) {
      expect(manifest.generated[file]).toBe(sha256(content));
    }
  });

  test("treats checkout CRLF as equivalent only for generated text", () => {
    expect(
      generatedBrandOutputMatches(Buffer.from("line one\r\nline two\r\n"), "line one\nline two\n"),
    ).toBe(true);
    expect(generatedBrandOutputMatches(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false);
  });

  test("keeps every checked-in derivative synchronized", async () => {
    await expect(generateDaseoBrandAssets({ check: true })).resolves.toBeInstanceOf(Map);
  });
});
