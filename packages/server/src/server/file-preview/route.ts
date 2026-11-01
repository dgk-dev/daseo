import { promises as fs } from "node:fs";
import type express from "express";
import type { Logger } from "pino";
import { renderMarkdownPage } from "./markdown-page.js";
import { TEXT_HTML, type PreviewLinkService } from "./service.js";

// Daseo delta 75: `GET /f/<token>/<fileName>` answers the tailnet preview link. It is mounted
// before the daemon password middleware, like the other capability-token routes, because the
// browser that opens it has no daemon password; the 128-bit token is the credential. Every
// response is inline, so Chrome renders what it can and offers an app for the rest.

const PREVIEW_TOKEN = /^[A-Za-z0-9_-]{22}$/;
// A markdown file larger than this is shown as text instead of rendered.
const MAX_RENDERED_MARKDOWN_BYTES = 5 * 1024 * 1024;

// A served page runs on the tailnet origin. The sandbox gives it an opaque origin, so its
// scripts cannot read another preview link or anything else on that host.
const ACTIVE_CONTENT_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";
const MARKDOWN_PAGE_CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; sandbox allow-popups";
const ACTIVE_CONTENT_TYPES = new Set([TEXT_HTML, "image/svg+xml"]);

export const PREVIEW_LINK_ROUTE = "/f/:token/:fileName";

function contentDisposition(fileName: string): string {
  // RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name, so Korean names survive.
  const asciiFallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function sendStatus(res: express.Response, status: number, message: string): void {
  res.status(status).type("text/plain; charset=utf-8").send(message);
}

export function createPreviewLinkRouteHandler(options: {
  service: PreviewLinkService;
  isHostAllowed: (host: string | undefined) => boolean;
  logger: Logger;
}): express.RequestHandler {
  const logger = options.logger.child({ module: "file-preview-route" });

  async function handle(req: express.Request, res: express.Response): Promise<void> {
    const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
    if (!options.isHostAllowed(host)) {
      res.status(403).json({ error: "Invalid Host header" });
      return;
    }
    const token = req.params.token ?? "";
    const fileName = req.params.fileName ?? "";
    if (!PREVIEW_TOKEN.test(token) || !fileName) {
      sendStatus(res, 404, "Not found");
      return;
    }
    const resolved = await options.service.resolve({ token, fileName });
    if (resolved.status === "expired") {
      sendStatus(res, 410, "This preview link has expired.");
      return;
    }
    if (resolved.status === "missing") {
      sendStatus(res, 404, "Not found");
      return;
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "private, no-cache");
    res.setHeader("Content-Disposition", contentDisposition(resolved.entry.fileName));

    if (resolved.serving.kind === "markdown") {
      const stats = await fs.stat(resolved.absolutePath);
      if (stats.size <= MAX_RENDERED_MARKDOWN_BYTES) {
        const source = await fs.readFile(resolved.absolutePath, "utf8");
        res.setHeader("Content-Security-Policy", MARKDOWN_PAGE_CSP);
        res
          .status(200)
          .type(TEXT_HTML)
          .send(renderMarkdownPage({ title: resolved.entry.fileName, source }));
        return;
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    } else {
      res.setHeader("Content-Type", resolved.serving.contentType);
      if (ACTIVE_CONTENT_TYPES.has(resolved.serving.contentType)) {
        res.setHeader("Content-Security-Policy", ACTIVE_CONTENT_CSP);
      }
    }

    // sendFile streams, answers HEAD, and serves Range requests (video and audio seek with them).
    // The Content-Type set above wins over its own extension lookup.
    res.sendFile(
      resolved.absolutePath,
      { dotfiles: "allow", acceptRanges: true, lastModified: true, cacheControl: false },
      (error) => {
        if (!error) {
          return;
        }
        // A player that seeks drops its earlier range request; that is not a failure.
        if ((error as NodeJS.ErrnoException).code !== "ECONNABORTED") {
          logger.warn({ err: error }, "Failed to send preview file");
        }
        if (!res.headersSent) {
          sendStatus(res, 404, "Not found");
        }
      },
    );
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error({ err: error }, "Preview link request failed");
      if (!res.headersSent) {
        sendStatus(res, 500, "Preview failed");
      }
    });
  };
}
