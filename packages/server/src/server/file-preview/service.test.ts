import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaseoToolConfig, PaseoToolResult } from "../agent/tools/types.js";
import { previewServing, PreviewLinkService } from "./service.js";
import { registerPreviewLinkTools } from "./tools.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_URL = "https://mac.example.ts.net/f";

describe("PreviewLinkService", () => {
  let root: string;
  let paseoHome: string;
  let now: number;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "preview-service-"));
    paseoHome = path.join(root, ".paseo");
    await mkdir(paseoHome);
    now = Date.parse("2026-11-01T00:00:00.000Z");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function createService(configured = true): PreviewLinkService {
    return new PreviewLinkService({
      paseoHome,
      settings: configured ? { baseUrl: BASE_URL, ttlMs: 30 * DAY_MS } : null,
      logger: pino({ level: "silent" }),
      now: () => now,
    });
  }

  it("issues a link for a file in the temp directory and resolves it", async () => {
    await writeFile(path.join(root, "최종 보고서.md"), "# hi\n");
    const service = createService();

    const created = await service.createLink({ path: path.join(root, "최종 보고서.md") });
    if (!created.ok) throw new Error(created.message);
    expect(created.url).toMatch(
      new RegExp(`^${BASE_URL}/[A-Za-z0-9_-]{22}/${encodeURIComponent("최종 보고서.md")}$`),
    );
    expect(created.expiresAt).toBe("2026-12-01T00:00:00.000Z");
    expect(created.fileName).toBe("최종 보고서.md");
    expect(created.mimeType).toBe("text/html; charset=utf-8");

    const token = created.url.split("/").at(-2) ?? "";
    const resolved = await service.resolve({ token, fileName: "최종 보고서.md" });
    expect(resolved.status).toBe("found");
    expect(resolved.status === "found" ? resolved.serving : null).toEqual({ kind: "markdown" });
    // Another name under the same token is a relative reference from the page, not this file.
    expect((await service.resolve({ token, fileName: "img.png" })).status).toBe("missing");

    now += 31 * DAY_MS;
    expect((await service.resolve({ token, fileName: "최종 보고서.md" })).status).toBe("expired");
  });

  it("resolves a path relative to cwd", async () => {
    await writeFile(path.join(root, "a.csv"), "a,b\n1,2\n");
    const created = await createService().createLink({ path: "a.csv", cwd: root });
    expect(created.ok && created.mimeType).toBe("text/plain; charset=utf-8");
  });

  it("refuses paths outside home and temp space, folders, missing files, and symlink escapes", async () => {
    const service = createService();
    const outside = await service.createLink({ path: "/etc/hosts" });
    expect(outside.ok ? null : outside.code).toBe("outside_scope");

    const folder = await service.createLink({ path: root });
    expect(folder.ok ? null : folder.code).toBe("not_a_file");

    const missing = await service.createLink({ path: path.join(root, "nope.md") });
    expect(missing.ok ? null : missing.code).toBe("not_found");

    await symlink("/etc/hosts", path.join(root, "escape.txt"));
    const escape = await service.createLink({ path: path.join(root, "escape.txt") });
    expect(escape.ok ? null : escape.code).toBe("outside_scope");

    const relative = await service.createLink({ path: "a.md" });
    expect(relative.ok ? null : relative.code).toBe("invalid_path");
  });

  it("stops serving a link whose file is replaced by a symlink out of scope", async () => {
    const filePath = path.join(root, "a.txt");
    await writeFile(filePath, "hello");
    const service = createService();
    const created = await service.createLink({ path: filePath });
    if (!created.ok) throw new Error(created.message);
    await rm(filePath);
    await symlink("/etc/hosts", filePath);

    const token = created.url.split("/").at(-2) ?? "";
    expect((await service.resolve({ token, fileName: "a.txt" })).status).toBe("missing");
  });

  it("says when no base URL is configured, and turns on after configure()", async () => {
    await writeFile(path.join(root, "a.txt"), "hello");
    const service = createService(false);
    expect(service.isConfigured()).toBe(false);
    const refused = await service.createLink({ path: path.join(root, "a.txt") });
    expect(refused.ok ? null : refused.code).toBe("not_configured");

    service.configure({ baseUrl: BASE_URL, ttlMs: DAY_MS });
    expect(service.isConfigured()).toBe(true);
    expect(service.publicHost()).toBe("mac.example.ts.net");
    const created = await service.createLink({ path: path.join(root, "a.txt") });
    if (!created.ok) throw new Error(created.message);
    const token = created.url.split("/").at(-2) ?? "";
    expect((await service.resolve({ token, fileName: "a.txt" })).status).toBe("found");

    // Turning the feature off stops serving links already handed out.
    service.configure(null);
    expect((await service.resolve({ token, fileName: "a.txt" })).status).toBe("missing");
  });
});

describe("previewServing", () => {
  it("serves documents and media with their real types and text as UTF-8 text", () => {
    expect(previewServing("a.pdf", "application/octet-stream")).toEqual({
      kind: "file",
      contentType: "application/pdf",
    });
    expect(previewServing("a.png", "image/png")).toEqual({
      kind: "file",
      contentType: "image/png",
    });
    expect(previewServing("a.mp4", "application/octet-stream").kind).toBe("file");
    expect(previewServing("a.docx", "application/octet-stream")).toEqual({
      kind: "file",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(previewServing("a.hwp", "application/octet-stream")).toEqual({
      kind: "file",
      contentType: "application/x-hwp",
    });
    expect(previewServing("page.html", "text/plain")).toEqual({
      kind: "file",
      contentType: "text/html; charset=utf-8",
    });
    expect(previewServing("a.json", "application/json")).toEqual({
      kind: "file",
      contentType: "application/json; charset=utf-8",
    });
    expect(previewServing("main.ts", "text/plain")).toEqual({
      kind: "file",
      contentType: "text/plain; charset=utf-8",
    });
    expect(previewServing("README.md", "text/plain")).toEqual({ kind: "markdown" });
    // Binary bytes behind a text name are not rendered or shown as text.
    expect(previewServing("blob.md", "application/octet-stream")).toEqual({
      kind: "file",
      contentType: "application/octet-stream",
    });
  });
});

describe("preview_link tool", () => {
  it("returns the link as structured content, and the refusal as an error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "preview-tool-"));
    try {
      await writeFile(path.join(root, "a.pdf"), "%PDF-1.4");
      const tools = new Map<string, (input: unknown) => Promise<PaseoToolResult>>();
      const configs = new Map<string, PaseoToolConfig>();
      const service = new PreviewLinkService({
        paseoHome: root,
        settings: { baseUrl: BASE_URL, ttlMs: DAY_MS },
        logger: pino({ level: "silent" }),
      });
      registerPreviewLinkTools({
        registerTool: (name, config, handler) => {
          tools.set(name, handler);
          configs.set(name, config);
        },
        service,
      });
      const handler = tools.get("preview_link");
      if (!handler) throw new Error("preview_link was not registered");
      expect(configs.get("preview_link")?.inputSchema).toHaveProperty("path");

      const ok = await handler({ path: path.join(root, "a.pdf") });
      expect(ok.isError).toBeUndefined();
      expect(ok.structuredContent).toMatchObject({
        fileName: "a.pdf",
        mimeType: "application/pdf",
      });
      expect((ok.structuredContent as { url: string }).url.startsWith(`${BASE_URL}/`)).toBe(true);

      const refused = await handler({ path: "/etc/hosts" });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toMatch(/^outside_scope: /);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
