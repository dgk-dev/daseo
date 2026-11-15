import { i18n } from "@/i18n/i18next";
import {
  isDraftSnapshotEmpty,
  removeSubmittedFromDraft,
  type DraftSnapshot,
} from "@/composer/draft-snapshot";

export type AgentInputSubmitResult = "noop" | "queued" | "submitted" | "failed";

export interface AgentInputSubmitActionInput<TAttachment> {
  message: string;
  attachments: TAttachment[];
  hasExternalContent?: boolean;
  allowEmptySubmit?: boolean;
  submitBehavior?: "clear" | "preserve-and-lock";
  forceSend?: boolean;
  isAgentRunning: boolean;
  canSubmit: boolean;
  queueMessage: (input: { message: string; attachments: TAttachment[] }) => Promise<void>;
  submitMessage: (input: { message: string; attachments: TAttachment[] }) => Promise<void>;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  setUserInput: (text: string) => void;
  setAttachments: (attachments: TAttachment[]) => void;
  /** The draft as it is now. The composer stays editable while a send is in flight. */
  readCurrentDraft: () => DraftSnapshot<TAttachment>;
  /** A failed send whose text cannot go back into the composer because newer input is there. */
  keepFailedSubmission: (failed: { message: string; attachments: TAttachment[] }) => void;
  setSendError: (message: string | null) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  onSubmitError?: (error: unknown) => void;
  failedToSendMessage?: string;
}

export async function submitAgentInput<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
): Promise<AgentInputSubmitResult> {
  const trimmedMessage = input.message.trim();
  const attachments = input.attachments;
  const shouldClearOnSubmit = input.submitBehavior !== "preserve-and-lock";

  if (
    !trimmedMessage &&
    attachments.length === 0 &&
    !input.hasExternalContent &&
    !input.allowEmptySubmit
  ) {
    return "noop";
  }

  if (!input.canSubmit) {
    return "noop";
  }

  if (input.isAgentRunning && !input.forceSend) {
    try {
      await input.queueMessage({ message: trimmedMessage, attachments });
    } catch (error) {
      input.onSubmitError?.(error);
      input.setSendError(resolveSendErrorMessage(input, error));
      return "failed";
    }
    if (shouldClearOnSubmit) {
      clearSubmittedFromDraft(input, { text: trimmedMessage, attachments });
    }
    return "queued";
  }

  // Clear immediately so the submitted timeline row and composer state stay in sync.
  if (shouldClearOnSubmit) {
    input.setUserInput("");
    input.setAttachments([]);
  }
  input.setSendError(null);
  input.setIsProcessing(true);

  try {
    await input.submitMessage({ message: trimmedMessage, attachments });
    settleSentDraft(input, { text: trimmedMessage, attachments }, shouldClearOnSubmit);
    input.setIsProcessing(false);
    return "submitted";
  } catch (error) {
    input.onSubmitError?.(error);
    if (shouldClearOnSubmit) {
      restoreFailedSubmission(input, { message: trimmedMessage, attachments });
    }
    input.setSendError(resolveSendErrorMessage(input, error));
    input.setIsProcessing(false);
    return "failed";
  }
}

function resolveSendErrorMessage<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend"));
}

/**
 * Text typed while the send was in flight is a new draft; finishing the send must not clear
 * it. A preserved draft is cleared only while it still shows exactly what was sent.
 */
function settleSentDraft<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
  sent: DraftSnapshot<TAttachment>,
  draftWasClearedOnSubmit: boolean,
): void {
  const current = input.readCurrentDraft();
  const remaining = draftWasClearedOnSubmit ? current : removeSubmittedFromDraft(current, sent);
  if (remaining && isDraftSnapshotEmpty(remaining)) {
    input.clearDraft("sent");
  }
}

/** Restores a failed message into an untouched empty draft; otherwise keeps it aside. */
function restoreFailedSubmission<TAttachment>(
  input: AgentInputSubmitActionInput<TAttachment>,
  failed: { message: string; attachments: TAttachment[] },
): void {
  if (isDraftSnapshotEmpty(input.readCurrentDraft())) {
    input.setUserInput(failed.message);
    input.setAttachments(failed.attachments);
    return;
  }
  input.keepFailedSubmission(failed);
}

/**
 * Removes a message that was just queued from the draft, keeping anything typed after it.
 * Leaves the draft alone when the queued text was edited in the meantime.
 */
export function clearSubmittedFromDraft<TAttachment>(
  input: Pick<
    AgentInputSubmitActionInput<TAttachment>,
    "readCurrentDraft" | "setUserInput" | "setAttachments"
  >,
  submitted: DraftSnapshot<TAttachment>,
): void {
  const current = input.readCurrentDraft();
  const remaining = removeSubmittedFromDraft(current, submitted);
  if (!remaining) return;
  if (remaining.text !== current.text) input.setUserInput(remaining.text);
  if (remaining.attachments.length !== current.attachments.length) {
    input.setAttachments([...remaining.attachments]);
  }
}
