import MarkdownIt from "markdown-it";
import { enableStreamingMarkdown } from "@/utils/streaming-markdown";

export function createAssistantMarkdownParser({ streaming = false } = {}): MarkdownIt {
  const parser = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
  });
  const defaultValidateLink = parser.validateLink.bind(parser);

  parser.validateLink = (url: string) =>
    url.trim().toLowerCase().startsWith("file://") || defaultValidateLink(url);

  if (streaming) {
    enableStreamingMarkdown(parser);
  }

  return parser;
}
