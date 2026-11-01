import { describe, expect, it } from "vitest";
import { fileExtension, nativeOpenRoute } from "./native-open-route";

describe("nativeOpenRoute", () => {
  it("keeps text, source, data, and markdown in the app", () => {
    for (const path of [
      "/Users/me/.pi/agent/plans/plan.md",
      "~/notes/README.MARKDOWN",
      "/tmp/page.html",
      "/tmp/page.htm",
      "/repo/src/index.ts",
      "/repo/app.tsx",
      "/repo/main.py",
      "/repo/report.csv",
      "/repo/data.tsv",
      "/repo/data.json",
      "/repo/events.jsonl",
      "/repo/events.ndjson",
      "/tmp/build.log",
      "/repo/config.yaml",
      "/repo/Cargo.toml",
      "/repo/schema.sql",
      "/repo/notes.txt",
      "/repo/.env",
    ]) {
      expect(nativeOpenRoute(path), path).toBe("in-app");
    }
  });

  it("keeps the images React Native decodes in the app", () => {
    for (const path of ["/a/shot.png", "/a/photo.JPG", "/a/photo.jpeg", "/a/a.gif", "/a/a.webp"]) {
      expect(nativeOpenRoute(path), path).toBe("in-app");
    }
  });

  it("sends documents, media, archives, and images without a native decoder to another app", () => {
    for (const path of [
      "/a/report.pdf",
      "/a/memo.docx",
      "/a/memo.doc",
      "/a/sheet.xlsx",
      "/a/sheet.xlsm",
      "/a/deck.pptx",
      "/a/문서.hwp",
      "/a/문서.hwpx",
      "/a/talk.key",
      "/a/clip.mp4",
      "/a/clip.mov",
      "/a/voice.m4a",
      "/a/song.mp3",
      "/a/bundle.zip",
      "/a/backup.tar",
      "/a/backup.tgz",
      "/a/app.sqlite",
      "/a/data.parquet",
      "/a/logo.svg",
      "/a/photo.heic",
      "/a/scan.tiff",
      "/a/favicon.ico",
      "/a/design.psd",
    ]) {
      expect(nativeOpenRoute(path), path).toBe("external");
    }
  });

  it("sends unknown and missing extensions to another app", () => {
    expect(nativeOpenRoute("/a/file.xyz")).toBe("external");
    expect(nativeOpenRoute("/a/Makefile")).toBe("external");
    expect(nativeOpenRoute("/a/folder/")).toBe("external");
    expect(nativeOpenRoute("/a/trailing.")).toBe("external");
  });
});

describe("fileExtension", () => {
  it("reads the last segment only", () => {
    expect(fileExtension("/a.b/c")).toBeNull();
    expect(fileExtension("/a/b.TAR.GZ")).toBe("gz");
    expect(fileExtension("C:\\docs\\report.PDF")).toBe("pdf");
    expect(fileExtension("/a/.gitignore")).toBe("gitignore");
  });
});
