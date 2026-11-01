import { z } from "zod";
import type { PaseoToolConfig, PaseoToolResult } from "../agent/tools/types.js";
import type { PreviewLinkService } from "./service.js";

// Daseo delta 75: `preview_link` lets an agent put an https link to a file it wrote straight
// into its answer; the owner opens it in Chrome on the phone or the Mac. Registered only in the
// daemon's own agent tool catalog.

type RegisterTool = (
  name: string,
  config: PaseoToolConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the catalog helper.
  handler: (input: any) => Promise<PaseoToolResult>,
) => void;

export function registerPreviewLinkTools(options: {
  registerTool: RegisterTool;
  service: PreviewLinkService;
}): void {
  options.registerTool(
    "preview_link",
    {
      title: "Preview link",
      description:
        "Make a tailnet https link that opens a local file in a browser: Chrome on the owner's phone or Mac renders PDF, HTML, images, video, audio, and text inline, markdown is rendered to a page, and office/HWP/archives download to an app. Pass an absolute or ~/ path under the home or temp directory. The link is valid for 30 days by default; put it in your answer as a markdown link. Fails when the host has no preview base URL configured.",
      inputSchema: {
        path: z.string().trim().min(1, "path is required"),
      },
      outputSchema: {
        url: z.string(),
        expiresAt: z.string(),
        fileName: z.string(),
        mimeType: z.string(),
      },
    },
    async ({ path }: { path: string }) => {
      const result = await options.service.createLink({ path });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `${result.code}: ${result.message}` }],
          isError: true,
        };
      }
      return {
        content: [],
        structuredContent: {
          url: result.url,
          expiresAt: result.expiresAt,
          fileName: result.fileName,
          mimeType: result.mimeType,
        },
      };
    },
  );
}
