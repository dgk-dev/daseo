import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// Daseo delta 75: the tailnet preview link, end to end — the WS RPC issues it, and the HTTP
// route answers it the way Tailscale Serve forwards it (Host = the tailnet name).

const CORRECT_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";
const PUBLIC_HOST = "mac.example.ts.net";
const BASE_URL = `https://${PUBLIC_HOST}/f`;
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c636001000000050001a5f645400000000049454e44ae426082",
  "hex",
);

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

// fetch() will not send a custom Host header, and the Host is what this route checks.
function get(input: {
  port: number;
  path: string;
  host: string;
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: input.method ?? "GET",
        headers: { ...input.headers, Host: input.host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function pathOf(publicUrl: string | null): string {
  return new URL(publicUrl ?? "https://invalid/").pathname;
}

describe("preview links", () => {
  let activeDaemon: TestPaseoDaemon | null = null;
  let activeClient: DaemonClient | null = null;
  const dirs: string[] = [];

  afterEach(async () => {
    await activeClient?.close();
    activeClient = null;
    await activeDaemon?.close();
    activeDaemon = null;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  async function start(options: Parameters<typeof createTestPaseoDaemon>[0] = {}) {
    const daemon = await createTestPaseoDaemon({
      hostnames: ["localhost"],
      previewLinks: { baseUrl: BASE_URL, ttlMs: 24 * 60 * 60 * 1000 },
      ...options,
    });
    activeDaemon = daemon;
    const daemonClient = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      ...(options.auth ? { password: "correct-password" } : {}),
    });
    activeClient = daemonClient;
    await daemonClient.connect();
    return { handle: daemon, client: daemonClient };
  }

  function fixtureDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "preview-links-e2e-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "보고서.md"), "# 결론\n\n<script>alert(1)</script>\n", "utf8");
    writeFileSync(path.join(dir, "report.pdf"), "%PDF-1.4\n%%EOF\n", "utf8");
    writeFileSync(path.join(dir, "shot.png"), PNG_BYTES);
    writeFileSync(path.join(dir, "clip.mp4"), Buffer.alloc(4096, 1));
    return dir;
  }

  test("issues links over WS and serves them inline under the tailnet Host", async () => {
    const { handle, client } = await start();
    expect(client.getLastServerInfoMessage()?.features?.previewLinks).toBe(true);
    const dir = fixtureDir();
    const port = handle.port;

    const markdown = await client.createPreviewLink({ path: "보고서.md", cwd: dir });
    expect(markdown.error).toBeNull();
    expect(markdown.url?.startsWith(`${BASE_URL}/`)).toBe(true);
    expect(markdown.mimeType).toBe("text/html; charset=utf-8");

    const page = await get({ port, path: pathOf(markdown.url), host: PUBLIC_HOST });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-disposition"]).toBe(
      `inline; filename="___.md"; filename*=UTF-8''${encodeURIComponent("보고서.md")}`,
    );
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    const html = page.body.toString("utf8");
    expect(html).toContain("<h1>결론</h1>");
    expect(html).not.toContain("<script>alert");

    // The same link opens again: tokens are reusable.
    const again = await get({
      port,
      path: pathOf(markdown.url),
      host: PUBLIC_HOST,
      method: "HEAD",
    });
    expect(again.status).toBe(200);

    const pdf = await client.createPreviewLink({ path: path.join(dir, "report.pdf") });
    const pdfResponse = await get({ port, path: pathOf(pdf.url), host: PUBLIC_HOST });
    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers["content-type"]).toBe("application/pdf");
    expect(pdfResponse.headers["content-disposition"]).toMatch(/^inline; /);
    expect(pdfResponse.headers["content-security-policy"]).toBeUndefined();
    expect(pdfResponse.body.toString("utf8")).toBe("%PDF-1.4\n%%EOF\n");

    const png = await client.createPreviewLink({ path: path.join(dir, "shot.png") });
    const pngResponse = await get({ port, path: pathOf(png.url), host: PUBLIC_HOST });
    expect(pngResponse.headers["content-type"]).toBe("image/png");
    expect(pngResponse.body.equals(PNG_BYTES)).toBe(true);

    const video = await client.createPreviewLink({ path: path.join(dir, "clip.mp4") });
    const ranged = await get({
      port,
      path: pathOf(video.url),
      host: PUBLIC_HOST,
      headers: { Range: "bytes=0-99" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-type"]).toBe("video/mp4");
    expect(ranged.headers["content-range"]).toBe("bytes 0-99/4096");
    expect(ranged.body.byteLength).toBe(100);
  }, 60000);

  test("refuses unknown tokens, foreign hosts, and paths outside home and temp space", async () => {
    const { handle, client } = await start();
    const dir = fixtureDir();
    const port = handle.port;

    const madeUp = await get({ port, path: `/f/${"A".repeat(22)}/x.md`, host: PUBLIC_HOST });
    expect(madeUp.status).toBe(404);
    const malformed = await get({ port, path: "/f/short/x.md", host: PUBLIC_HOST });
    expect(malformed.status).toBe(404);

    const link = await client.createPreviewLink({ path: path.join(dir, "report.pdf") });
    const foreignHost = await get({ port, path: pathOf(link.url), host: "evil.example.com" });
    expect(foreignHost.status).toBe(403);
    const localHost = await get({ port, path: pathOf(link.url), host: `localhost:${port}` });
    expect(localHost.status).toBe(200);
    // The tailnet Host opens preview links only; the rest of the daemon still refuses it.
    const apiUnderPublicHost = await get({ port, path: "/api/status", host: PUBLIC_HOST });
    expect(apiUnderPublicHost.status).toBe(403);

    const outside = await client.createPreviewLink({ path: "/etc/hosts" });
    expect(outside.url).toBeNull();
    expect(outside.error?.code).toBe("outside_scope");
  }, 60000);

  test("answers without the daemon password: the token is the credential", async () => {
    const { handle, client } = await start({ auth: { password: CORRECT_PASSWORD_HASH } });
    const dir = fixtureDir();
    const link = await client.createPreviewLink({ path: path.join(dir, "report.pdf") });
    expect(link.error).toBeNull();

    const response = await get({ port: handle.port, path: pathOf(link.url), host: PUBLIC_HOST });
    expect(response.status).toBe(200);
    const status = await get({
      port: handle.port,
      path: "/api/status",
      host: `localhost:${handle.port}`,
    });
    expect(status.status).toBe(401);
  }, 60000);

  test("reports the feature off when no base URL is configured", async () => {
    const { client } = await start({ previewLinks: null });
    expect(client.getLastServerInfoMessage()?.features?.previewLinks).toBe(false);
    const dir = fixtureDir();
    const refused = await client.createPreviewLink({ path: path.join(dir, "report.pdf") });
    expect(refused.url).toBeNull();
    expect(refused.error?.code).toBe("not_configured");
  }, 60000);
});
