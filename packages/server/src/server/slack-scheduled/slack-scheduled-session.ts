import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { SlackScheduledActions } from "./slack-scheduled-actions.js";
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

const ACTIONS_UNAVAILABLE = "Changing scheduled Slack messages is not available on this host";

/**
 * Daseo delta 135 (2026-11-23): answers schedule.slack.cancel.request, the owner's 취소 button.
 * A runtime without the runner answers with an error.
 */
export async function handleScheduleSlackCancelRequest(options: {
  actions: SlackScheduledActions | null | undefined;
  request: Extract<SessionInboundMessage, { type: "schedule.slack.cancel.request" }>;
  emit: (message: SessionOutboundMessage) => void;
}): Promise<void> {
  const { actions, request, emit } = options;
  const result = actions
    ? await actions.run({ action: "cancel", id: request.id })
    : { ok: false, newId: null, error: ACTIONS_UNAVAILABLE };
  emit({
    type: "schedule.slack.cancel.response",
    payload: { requestId: request.requestId, ok: result.ok, error: result.error },
  });
}

/**
 * Daseo delta 135 (2026-11-23): answers schedule.slack.update.request, the owner's 시간 변경 and
 * 내용 수정 buttons. A runtime without the runner answers with an error.
 */
export async function handleScheduleSlackUpdateRequest(options: {
  actions: SlackScheduledActions | null | undefined;
  request: Extract<SessionInboundMessage, { type: "schedule.slack.update.request" }>;
  emit: (message: SessionOutboundMessage) => void;
}): Promise<void> {
  const { actions, request, emit } = options;
  const result = actions
    ? await actions.run({
        action: "change",
        id: request.id,
        ...(request.postAt !== undefined ? { postAt: request.postAt } : {}),
        ...(request.text !== undefined ? { text: request.text } : {}),
      })
    : { ok: false, newId: null, error: ACTIONS_UNAVAILABLE };
  emit({
    type: "schedule.slack.update.response",
    payload: {
      requestId: request.requestId,
      ok: result.ok,
      newId: result.newId,
      error: result.error,
    },
  });
}
