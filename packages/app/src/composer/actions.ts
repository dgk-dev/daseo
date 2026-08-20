import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type {
  AttachmentMetadata,
  ComposerAttachment,
  UserComposerAttachment,
} from "@/attachments/types";
import {
  isWorkspaceAttachment,
  userAttachmentsOnly,
} from "@/attachments/workspace-attachment-utils";
import {
  splitComposerAttachmentsForSubmit,
  type ComposerAttachmentSubmitFormat,
} from "@/composer/attachments/submit";
import { createUserMessage, generateMessageId, type UserMessageItem } from "@/types/stream";
import type { MessageSubmissionRejectionOutcome } from "@/composer/submission/model";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";
import { i18n } from "@/i18n/i18next";
import { composerOutboxStore, type ComposerOutboxRecord } from "@/composer/outbox/store";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";

export interface QueuedComposerMessage {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  resolution?: {
    status: "delivery_unknown" | "in_flight" | "rejected";
    message?: string | null;
  };
}

export interface CommandReceiptResolver {
  getAgentCommandReceipt(commandId: string): Promise<{
    status: "missing" | "in_flight" | "accepted" | "rejected" | "retry_ready";
    error: string | null;
  }>;
  resolveAgentCommandReceipt(
    commandId: string,
    action: "retry" | "discard",
  ): Promise<{
    status: "missing" | "in_flight" | "accepted" | "rejected" | "retry_ready";
    error: string | null;
  }>;
}

export interface AttachmentPersister {
  persistFromBlob: (input: {
    blob: Blob;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  persistFromFileUri: (input: {
    uri: string;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  persistFromDataUrl: (input: {
    dataUrl: string;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  deleteAttachments: (metadata: AttachmentMetadata[]) => Promise<void> | void;
}

export interface ComposerSendClient {
  sendAgentMessage: (
    agentId: string,
    text: string,
    options: {
      messageId: string;
      commandId: string;
      images: Array<{ data: string; mimeType: string }>;
      attachments: ReturnType<typeof splitComposerAttachmentsForSubmit>["attachments"];
    },
  ) => Promise<{ receiptStatus?: "in_flight" | "accepted" | "rejected" } | void>;
  getAgentCommandReceipt?: (commandId: string) => Promise<{
    status: "missing" | "in_flight" | "accepted" | "rejected" | "retry_ready";
    error: string | null;
  }>;
  uploadFile: (input: { fileName: string; mimeType: string; bytes: Uint8Array }) => Promise<{
    requestId: string;
    file: {
      type: "uploaded_file";
      id: string;
      fileName: string;
      mimeType: string;
      size: number;
      path: string;
    } | null;
    error: string | null;
  }>;
}

export interface ComposerCancelClient {
  cancelAgent: (agentId: string) => Promise<void> | void;
}

export interface MessageSubmissionWriter {
  begin: (agentId: string, message: UserMessageItem) => void;
  accept: (agentId: string, clientMessageId: string) => void;
  reject: (agentId: string, clientMessageId: string) => MessageSubmissionRejectionOutcome;
}

export interface QueueWriter {
  read: (agentId: string) => QueuedComposerMessage[];
  write: (
    updater: (prev: Map<string, QueuedComposerMessage[]>) => Map<string, QueuedComposerMessage[]>,
  ) => void;
}

export interface ComposerOutboxWriter {
  enqueue(input: {
    id: string;
    serverId: string;
    agentId: string;
    text: string;
    attachments: ComposerAttachment[];
    intent: ComposerOutboxRecord["intent"];
    steering?: boolean;
  }): Promise<ComposerOutboxRecord>;
  mark(input: {
    serverId: string;
    id: string;
    intent?: ComposerOutboxRecord["intent"];
    status: ComposerOutboxRecord["status"];
    lastError?: string | null;
    incrementAttempt?: boolean;
  }): Promise<ComposerOutboxRecord | null>;
  remove(serverId: string, id: string): Promise<boolean>;
}

function isDeliveryUnknownError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AgentCommandDeliveryUnknownError";
}

export async function pickAndPersistImages(input: {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
  persister: Pick<
    AttachmentPersister,
    "persistFromBlob" | "persistFromFileUri" | "persistFromDataUrl" | "deleteAttachments"
  >;
}): Promise<AttachmentMetadata[]> {
  const result = await input.pickImages();
  if (!result?.length) return [];
  const persisted = await Promise.allSettled(
    result.map(async (picked) => {
      const fileName = picked.fileName ?? null;
      const mimeType = picked.mimeType;
      if (picked.source.kind === "blob") {
        return await input.persister.persistFromBlob({
          blob: picked.source.blob,
          mimeType,
          fileName,
        });
      }
      if (picked.source.kind === "data_url") {
        return await input.persister.persistFromDataUrl({
          dataUrl: picked.source.dataUrl,
          mimeType,
          fileName,
        });
      }
      return await input.persister.persistFromFileUri({
        uri: picked.source.uri,
        mimeType,
        fileName,
      });
    }),
  );
  const attachments = persisted.flatMap((entry) =>
    entry.status === "fulfilled" ? [entry.value] : [],
  );
  const failures = persisted.flatMap((entry) =>
    entry.status === "rejected" ? [entry.reason] : [],
  );
  if (failures.length > 0) {
    await input.persister.deleteAttachments(attachments);
    throw new AggregateError(failures, "Failed to persist selected image attachments.");
  }
  return attachments;
}

export async function uploadFileAttachments(input: {
  client: ComposerSendClient;
  files: Array<{ fileName: string; mimeType: string; bytes: Uint8Array }>;
}): Promise<Extract<ComposerAttachment, { kind: "file" }>[]> {
  const result: Extract<ComposerAttachment, { kind: "file" }>[] = [];

  for (const file of input.files) {
    const response = await input.client.uploadFile(file);
    if (response.error || !response.file) {
      throw new Error(response.error ?? "Upload failed.");
    }
    result.push({ kind: "file", attachment: response.file });
  }

  return result;
}

export function removeComposerAttachmentAtIndex<T extends ComposerAttachment>(input: {
  attachments: T[];
  index: number;
  deleteAttachments: AttachmentPersister["deleteAttachments"];
}): T[] {
  const removed = input.attachments[input.index];
  if (removed?.kind === "image") {
    void input.deleteAttachments([removed.metadata]);
  }
  return input.attachments.filter((_, i) => i !== input.index);
}

export interface CancelComposerAgentInput {
  client: ComposerCancelClient | null;
  agentId: string;
  isAgentRunning: boolean;
  isCancellingAgent: boolean;
  isConnected: boolean;
}

export function cancelComposerAgent(input: CancelComposerAgentInput): Promise<void> | null {
  if (!input.isAgentRunning || input.isCancellingAgent) return null;
  if (!input.isConnected || !input.client) return null;
  try {
    return Promise.resolve(input.client.cancelAgent(input.agentId));
  } catch (error) {
    return Promise.reject(error);
  }
}

export interface DispatchComposerAgentMessageInput {
  client: ComposerSendClient;
  serverId: string;
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  attachmentSubmitFormat?: ComposerAttachmentSubmitFormat;
  encodeImages: (
    images: AttachmentMetadata[],
  ) => Promise<Array<{ data: string; mimeType: string }> | undefined>;
  submission: MessageSubmissionWriter;
  steering?: boolean;
  clientMessageId?: string;
  outbox?: ComposerOutboxWriter;
  preserveRejectedOutbox?: boolean;
}

interface ReconcileInFlightComposerMessageInput {
  client: ComposerSendClient;
  outbox: ComposerOutboxWriter;
  submission: MessageSubmissionWriter;
  serverId: string;
  agentId: string;
  clientMessageId: string;
  steering: boolean;
}

async function reconcileInFlightComposerMessage(
  input: ReconcileInFlightComposerMessageInput,
): Promise<void> {
  const receipt = await input.client.getAgentCommandReceipt?.(input.clientMessageId);
  if (receipt?.status === "accepted") {
    await input.outbox.remove(input.serverId, input.clientMessageId);
    input.submission.accept(input.agentId, input.clientMessageId);
    return;
  }
  const rejected = receipt?.status === "rejected";
  await input.outbox.mark({
    serverId: input.serverId,
    id: input.clientMessageId,
    status: rejected ? "rejected" : "in_flight",
    lastError: receipt?.error ?? null,
  });
  if (input.steering && !rejected) {
    // Active-turn commands are durably admitted before Pi may finish
    // compaction and acknowledge the native steer. Keep the optimistic
    // message in place while the host runtime reconciles that receipt.
    input.submission.accept(input.agentId, input.clientMessageId);
    return;
  }
  input.submission.reject(input.agentId, input.clientMessageId);
}

async function preserveDeliveryUnknownComposerMessage(input: {
  outbox: ComposerOutboxWriter;
  submission: MessageSubmissionWriter;
  serverId: string;
  agentId: string;
  clientMessageId: string;
  steering: boolean;
  error: Error;
}): Promise<void> {
  await input.outbox.mark({
    serverId: input.serverId,
    id: input.clientMessageId,
    status: "delivery_unknown",
    lastError: input.error.message,
  });
  // A steering write can outlive a relay response while Pi is compacting.
  // Its durable command id is safe to reconcile automatically, so do not
  // turn the optimistic message into a manual retry/discard row.
  if (!input.steering) {
    input.submission.reject(input.agentId, input.clientMessageId);
  }
}

export async function dispatchComposerAgentMessage(
  input: DispatchComposerAgentMessageInput,
): Promise<void> {
  const wirePayload = splitComposerAttachmentsForSubmit(input.attachments, {
    format: input.attachmentSubmitFormat,
  });
  const clientMessageId = input.clientMessageId ?? generateMessageId();
  const outbox = input.outbox ?? composerOutboxStore;
  const retainedAttachmentIds = input.attachments.flatMap((attachment) => {
    if (attachment.kind === "image") return [attachment.metadata.id];
    if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
      return [attachment.attachment.screenshot.id];
    }
    return [];
  });
  const releaseRetention = retainedAttachmentIds.map(retainAttachmentForGarbageCollection);
  try {
    await outbox.enqueue({
      id: clientMessageId,
      serverId: input.serverId,
      agentId: input.agentId,
      text: input.text,
      attachments: input.attachments,
      intent: "dispatch",
      steering: input.steering,
    });
  } finally {
    for (const release of releaseRetention) release();
  }
  const userMessage = createUserMessage({
    clientMessageId,
    text: input.text,
    timestamp: new Date(),
    images: wirePayload.images,
    attachments: wirePayload.attachments,
    steering: input.steering,
  });
  input.submission.begin(input.agentId, userMessage);
  try {
    const imagesData = await input.encodeImages(wirePayload.images);
    await outbox.mark({
      serverId: input.serverId,
      id: clientMessageId,
      status: "pending",
      incrementAttempt: true,
    });
    const result = await input.client.sendAgentMessage(input.agentId, input.text, {
      messageId: clientMessageId,
      commandId: clientMessageId,
      images: imagesData ?? [],
      attachments: wirePayload.attachments,
    });
    if (result?.receiptStatus === "in_flight") {
      await reconcileInFlightComposerMessage({
        client: input.client,
        outbox,
        submission: input.submission,
        serverId: input.serverId,
        agentId: input.agentId,
        clientMessageId,
        steering: input.steering === true,
      });
      return;
    }
    await outbox.remove(input.serverId, clientMessageId);
    input.submission.accept(input.agentId, clientMessageId);
  } catch (error) {
    if (isDeliveryUnknownError(error)) {
      await preserveDeliveryUnknownComposerMessage({
        outbox,
        submission: input.submission,
        serverId: input.serverId,
        agentId: input.agentId,
        clientMessageId,
        steering: input.steering === true,
        error,
      });
      return;
    }
    if (input.preserveRejectedOutbox) {
      await outbox.mark({
        serverId: input.serverId,
        id: clientMessageId,
        status: "rejected",
        lastError: error instanceof Error ? error.message : "Command rejected",
      });
    } else {
      await outbox.remove(input.serverId, clientMessageId);
    }
    const outcome = input.submission.reject(input.agentId, clientMessageId);
    if (outcome === "accepted") return;
    throw error;
  }
}

export interface QueueComposerMessageInput {
  serverId: string;
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  queue: QueueWriter;
  outbox?: ComposerOutboxWriter;
}

export interface QueueComposerMessageResult {
  queued: QueuedComposerMessage | null;
}

export async function queueComposerMessage(
  input: QueueComposerMessageInput,
): Promise<QueueComposerMessageResult> {
  const trimmed = input.text.trim();
  if (!trimmed && input.attachments.length === 0) {
    return { queued: null };
  }
  const item: QueuedComposerMessage = {
    id: generateMessageId(),
    text: trimmed,
    attachments: input.attachments,
  };
  await (input.outbox ?? composerOutboxStore).enqueue({
    id: item.id,
    serverId: input.serverId,
    agentId: input.agentId,
    text: item.text,
    attachments: item.attachments,
    intent: "queued",
  });
  input.queue.write((prev) => {
    const current = prev.get(input.agentId) ?? [];
    if (current.some((message) => message.id === item.id)) return prev;
    const next = new Map(prev);
    next.set(input.agentId, [...current, item]);
    return next;
  });
  return { queued: item };
}

export interface EditQueuedComposerMessageInput {
  serverId: string;
  agentId: string;
  messageId: string;
  queue: QueueWriter;
  outbox?: ComposerOutboxWriter;
  receiptResolver?: CommandReceiptResolver;
}

export interface EditQueuedComposerMessageResult {
  text: string;
  attachments: UserComposerAttachment[];
}

export async function editQueuedComposerMessage(
  input: EditQueuedComposerMessageInput,
): Promise<EditQueuedComposerMessageResult | null> {
  const item = input.queue.read(input.agentId).find((q) => q.id === input.messageId);
  if (!item) return null;
  if (item.resolution) {
    if (!input.receiptResolver) throw new Error("Host cannot resolve this uncertain delivery");
    const resolution = await input.receiptResolver.resolveAgentCommandReceipt(item.id, "discard");
    if (resolution.status === "accepted") {
      await (input.outbox ?? composerOutboxStore).remove(input.serverId, input.messageId);
      input.queue.write((previous) => {
        const next = new Map(previous);
        next.set(
          input.agentId,
          (previous.get(input.agentId) ?? []).filter((message) => message.id !== input.messageId),
        );
        return next;
      });
      return null;
    }
  }
  await (input.outbox ?? composerOutboxStore).remove(input.serverId, input.messageId);
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(
      input.agentId,
      (prev.get(input.agentId) ?? []).filter((q) => q.id !== input.messageId),
    );
    return next;
  });
  return {
    text: item.text,
    attachments: userAttachmentsOnly(item.attachments),
  };
}

export interface DiscardQueuedComposerMessageInput {
  serverId: string;
  agentId: string;
  messageId: string;
  queue: QueueWriter;
  outbox?: ComposerOutboxWriter;
  receiptResolver?: CommandReceiptResolver;
}

export async function discardQueuedComposerMessage(
  input: DiscardQueuedComposerMessageInput,
): Promise<"missing" | "discarded" | "already_accepted"> {
  const item = input.queue.read(input.agentId).find((message) => message.id === input.messageId);
  if (!item) return "missing";
  let result: "discarded" | "already_accepted" = "discarded";
  if (item.resolution) {
    if (!input.receiptResolver) throw new Error("Host cannot resolve this uncertain delivery");
    const resolution = await input.receiptResolver.resolveAgentCommandReceipt(item.id, "discard");
    if (resolution.status === "accepted") result = "already_accepted";
  }
  await (input.outbox ?? composerOutboxStore).remove(input.serverId, input.messageId);
  input.queue.write((previous) => {
    const next = new Map(previous);
    next.set(
      input.agentId,
      (previous.get(input.agentId) ?? []).filter((message) => message.id !== input.messageId),
    );
    return next;
  });
  return result;
}

export interface SendQueuedComposerMessageNowInput {
  serverId: string;
  agentId: string;
  messageId: string;
  queue: QueueWriter;
  outbox?: ComposerOutboxWriter;
  submitMessage: (input: {
    text: string;
    attachments: ComposerAttachment[];
    clientMessageId: string;
  }) => Promise<void>;
  receiptResolver?: CommandReceiptResolver;
  failedToSendMessage?: string;
}

export type SendQueuedComposerMessageNowResult =
  | { status: "missing" }
  | { status: "submitted" }
  | { status: "already_accepted" }
  | { status: "failed"; errorMessage: string };

export async function sendQueuedComposerMessageNow(
  input: SendQueuedComposerMessageNowInput,
): Promise<SendQueuedComposerMessageNowResult> {
  const item = input.queue.read(input.agentId).find((q) => q.id === input.messageId);
  if (!item) return { status: "missing" };
  const outbox = input.outbox ?? composerOutboxStore;
  if (item.resolution) {
    if (!input.receiptResolver) {
      return { status: "failed", errorMessage: "Host cannot resolve this uncertain delivery" };
    }
    const resolution = await input.receiptResolver.resolveAgentCommandReceipt(item.id, "retry");
    if (resolution.status === "accepted") {
      await outbox.remove(input.serverId, item.id);
      input.queue.write((previous) => {
        const next = new Map(previous);
        next.set(
          input.agentId,
          (previous.get(input.agentId) ?? []).filter((message) => message.id !== item.id),
        );
        return next;
      });
      return { status: "already_accepted" };
    }
    if (resolution.status !== "retry_ready") {
      return {
        status: "failed",
        errorMessage: resolution.error ?? `Unable to retry command (${resolution.status})`,
      };
    }
  }
  await outbox.mark({
    serverId: input.serverId,
    id: item.id,
    intent: "dispatch",
    status: "pending",
  });
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(
      input.agentId,
      (prev.get(input.agentId) ?? []).filter((q) => q.id !== input.messageId),
    );
    return next;
  });
  try {
    await input.submitMessage({
      text: item.text,
      attachments: item.attachments,
      clientMessageId: item.id,
    });
    return { status: "submitted" };
  } catch (error) {
    await outbox.enqueue({
      id: item.id,
      serverId: input.serverId,
      agentId: input.agentId,
      text: item.text,
      attachments: item.attachments,
      intent: "queued",
    });
    await outbox.mark({
      serverId: input.serverId,
      id: item.id,
      intent: "queued",
      status: "queued",
      lastError: error instanceof Error ? error.message : "Failed to send queued message",
    });
    input.queue.write((prev) => {
      const current = (prev.get(input.agentId) ?? []).filter((message) => message.id !== item.id);
      const next = new Map(prev);
      next.set(input.agentId, [item, ...current]);
      return next;
    });
    return {
      status: "failed",
      errorMessage:
        error instanceof Error
          ? error.message
          : (input.failedToSendMessage ?? i18n.t("composer.errors.failedToSend")),
    };
  }
}

export interface OpenComposerAttachmentInput {
  attachment: ComposerAttachment;
  setLightboxMetadata: (metadata: AttachmentMetadata) => void;
  openWorkspaceAttachment: (input: { attachment: ComposerAttachment }) => boolean;
  openExternalUrl: (url: string) => void;
}

export function openComposerAttachment(input: OpenComposerAttachmentInput): void {
  if (input.attachment.kind === "image") {
    input.setLightboxMetadata(input.attachment.metadata);
    return;
  }
  if (input.attachment.kind === "file" || input.attachment.kind === "workspace_file") {
    return;
  }
  if (isWorkspaceAttachment(input.attachment)) {
    input.openWorkspaceAttachment({ attachment: input.attachment });
    return;
  }
  input.openExternalUrl(input.attachment.item.url);
}

export function buildForgeAttachment(item: ForgeSearchItem): UserComposerAttachment {
  return item.kind === "change_request"
    ? { kind: "forge_change_request", item }
    : { kind: "forge_issue", item };
}

function isForgeAttachment(
  attachment: UserComposerAttachment,
): attachment is Extract<
  UserComposerAttachment,
  { kind: "forge_issue" | "forge_change_request" | "github_issue" | "github_pr" }
> {
  return (
    attachment.kind === "forge_issue" ||
    attachment.kind === "forge_change_request" ||
    // COMPAT(githubAttachmentKinds): added in v0.1.106, remove after 2026-12-28 once daemon floor >= v0.1.106
    attachment.kind === "github_issue" ||
    attachment.kind === "github_pr"
  );
}

export function toggleForgeAttachment(
  current: UserComposerAttachment[],
  item: ForgeSearchItem,
): UserComposerAttachment[] {
  const matches = (attachment: UserComposerAttachment) =>
    isForgeAttachment(attachment) &&
    attachment.item.kind === item.kind &&
    attachment.item.number === item.number;
  if (current.some(matches)) {
    return current.filter((attachment) => !matches(attachment));
  }
  return [...current, buildForgeAttachment(item)];
}

interface ToggleGithubAttachmentFromPickerInput {
  current: UserComposerAttachment[];
  item: ForgeSearchItem;
  markGithubAttachmentRemoved: (attachment: UserComposerAttachment) => void;
}

export function toggleGithubAttachmentFromPicker({
  current,
  item,
  markGithubAttachmentRemoved,
}: ToggleGithubAttachmentFromPickerInput): UserComposerAttachment[] {
  const existingAttachment = current.find(
    (attachment) =>
      isForgeAttachment(attachment) &&
      attachment.item.kind === item.kind &&
      attachment.item.number === item.number,
  );
  if (existingAttachment) {
    markGithubAttachmentRemoved(existingAttachment);
  }
  return toggleForgeAttachment(current, item);
}

export function findGithubItemByOption(
  items: readonly ForgeSearchItem[],
  optionId: string,
): ForgeSearchItem | undefined {
  return items.find((candidate) => `${candidate.kind}:${candidate.number}` === optionId);
}

export function isAttachmentSelectedForGithubItem(
  current: readonly ComposerAttachment[],
  item: ForgeSearchItem,
): boolean {
  return userAttachmentsOnly(current).some(
    (attachment) =>
      isForgeAttachment(attachment) &&
      attachment.item.kind === item.kind &&
      attachment.item.number === item.number,
  );
}

export const toggleGithubAttachment = toggleForgeAttachment;
