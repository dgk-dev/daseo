import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { SlackScheduledReader } from "./slack-scheduled-reader.js";

/**
 * Daseo delta 135: answers schedule.slack.list.request. A runtime without a reader (tests,
 * embedded daemons) answers with an error instead of leaving the request unanswered.
 */
export async function handleScheduleSlackListRequest(options: {
  reader: SlackScheduledReader | null | undefined;
  request: Extract<SessionInboundMessage, { type: "schedule.slack.list.request" }>;
  emit: (message: SessionOutboundMessage) => void;
  logger: pino.Logger;
}): Promise<void> {
  const { reader, request, emit, logger } = options;
  if (!reader) {
    emit({
      type: "schedule.slack.list.response",
      payload: {
        requestId: request.requestId,
        entries: [],
        source: null,
        fetchedAt: null,
        warning: null,
        error: "Scheduled Slack messages are not available on this host",
      },
    });
    return;
  }
  try {
    const result = await reader.list();
    emit({
      type: "schedule.slack.list.response",
      payload: {
        requestId: request.requestId,
        entries: result.entries,
        source: result.source,
        fetchedAt: result.fetchedAt,
        warning: result.warning,
        error: null,
      },
    });
  } catch (error) {
    logger.warn({ err: error }, "Failed to list scheduled Slack messages");
    emit({
      type: "schedule.slack.list.response",
      payload: {
        requestId: request.requestId,
        entries: [],
        source: null,
        fetchedAt: null,
        warning: null,
        error: getErrorMessage(error),
      },
    });
  }
}
