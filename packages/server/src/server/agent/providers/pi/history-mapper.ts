import type { AssistantMessagePhase } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEvent, AgentTimelineItem, ToolCallDetail } from "../../agent-sdk-types.js";
import type { PiAgentMessage, PiImageContent, PiTextContent } from "./rpc-types.js";
import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
  type PiToolResult,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";

export interface PiCapturedUserMessageEntry {
  id: string;
  text: string;
}

export interface PiHistoryMapperHooks {
  mapCustomMessage?: (
    text: string,
    provider: string,
  ) => Extract<AgentStreamEvent, { type: "timeline" }> | null;
  resolveToolCallId?: (toolCallId: string, toolCall: PiTrackedToolCall) => string;
  mapToolDetail?: (
    toolCall: PiTrackedToolCall,
    result: PiToolResult,
    context: { toolCallId: string },
  ) => ToolCallDetail | null;
}

function isTextContentBlock(block: unknown): block is PiTextContent {
  return (
    typeof block === "object" &&
    block !== null &&
    !Array.isArray(block) &&
    Reflect.get(block, "type") === "text" &&
    typeof Reflect.get(block, "text") === "string"
  );
}

export function getUserMessageText(content: string | (PiTextContent | PiImageContent)[]): string {
  if (typeof content === "string") {
    return content;
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (isTextContentBlock(block)) {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n\n");
}

export function getPiTextContentPhase(content: PiTextContent): AssistantMessagePhase | undefined {
  if (typeof content.textSignature !== "string") return undefined;
  try {
    const signature: unknown = JSON.parse(content.textSignature);
    if (typeof signature !== "object" || signature === null || Array.isArray(signature)) {
      return undefined;
    }
    const phase = Reflect.get(signature, "phase");
    return phase === "commentary" || phase === "final_answer" ? phase : undefined;
  } catch {
    return undefined;
  }
}

export function getPiAssistantMessagePhase(
  message: Extract<PiAgentMessage, { role: "assistant" }>,
): AssistantMessagePhase | undefined {
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const content = message.content[index];
    if (content?.type !== "text") continue;
    const phase = getPiTextContentPhase(content);
    if (phase) return phase;
  }
  return undefined;
}

/**
 * Phase derived from why Pi says the model stopped, for providers that never
 * attach a phase signature (Claude through the bridge). `stop` on a message
 * with text means the model finished speaking on its own: that text is its
 * answer at that point, even if a queued follow-up (a background fetch
 * notification, a steer) wakes it again inside the same turn. `toolUse` text
 * is narration before work and stays phase-less so it folds. Only valid once
 * the message is complete; a streaming message carries a placeholder
 * `stopReason` until then.
 */
export function getPiStopReasonPhase(
  message: Extract<PiAgentMessage, { role: "assistant" }>,
): AssistantMessagePhase | undefined {
  if (message.stopReason?.toLowerCase() !== "stop") return undefined;
  const hasText = message.content.some(
    (content) => content.type === "text" && content.text.trim().length > 0,
  );
  return hasText ? "final_answer" : undefined;
}

/** Phase for a completed assistant message: an explicit signature wins, else
 *  the stop-reason derivation. */
export function getPiAssistantMessageEndPhase(
  message: Extract<PiAgentMessage, { role: "assistant" }>,
): AssistantMessagePhase | undefined {
  return getPiAssistantMessagePhase(message) ?? getPiStopReasonPhase(message);
}

export class PiHistoryMapper {
  private readonly pendingToolCalls = new Map<string, PiTrackedToolCall>();
  private userIndex = 0;
  private assistantIndex = 0;
  private hasUserInCurrentTurn = false;
  private sawExplicitAssistantPhase = false;
  private currentTurnHasFinalAnswer = false;

  constructor(
    private readonly provider: string,
    private readonly userEntries: readonly PiCapturedUserMessageEntry[] = [],
    private readonly hooks: PiHistoryMapperHooks = {},
  ) {}

  mapMessages(messages: readonly PiAgentMessage[]): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];

    for (const message of messages) {
      switch (message.role) {
        case "user":
          events.push(...this.mapUserMessage(message));
          break;
        case "custom":
          events.push(...this.mapCustomMessage(message));
          break;
        case "assistant":
          events.push(...this.mapAssistantMessage(message));
          break;
        case "toolResult": {
          const event = this.mapToolResultMessage(message);
          if (event) {
            events.push(event);
          }
          break;
        }
        case "bashExecution":
          events.push(this.mapBashExecutionMessage(message));
          break;
      }
    }

    return events;
  }

  private mapUserMessage(message: Extract<PiAgentMessage, { role: "user" }>): AgentStreamEvent[] {
    const text = getUserMessageText(message.content);
    this.userIndex += 1;
    if (!text) {
      return [];
    }
    const userEntry = this.userEntries[this.userIndex - 1];
    const steering =
      this.hasUserInCurrentTurn &&
      this.sawExplicitAssistantPhase &&
      !this.currentTurnHasFinalAnswer;
    if (!steering) {
      this.sawExplicitAssistantPhase = false;
      this.currentTurnHasFinalAnswer = false;
    }
    this.hasUserInCurrentTurn = true;
    return [
      {
        type: "timeline",
        provider: this.provider,
        item: {
          type: "user_message",
          text,
          ...(userEntry ? { messageId: userEntry.id } : {}),
          ...(steering ? { steering: true } : {}),
        },
      },
    ];
  }

  private mapCustomMessage(
    message: Extract<PiAgentMessage, { role: "custom" }>,
  ): AgentStreamEvent[] {
    const text = getUserMessageText(message.content);
    const mappedEvent = text ? this.hooks.mapCustomMessage?.(text, this.provider) : null;
    if (mappedEvent) {
      return [mappedEvent];
    }
    return text
      ? [
          {
            type: "timeline",
            provider: this.provider,
            item: { type: "assistant_message", text, phase: "commentary" },
          },
        ]
      : [];
  }

  private mapAssistantMessage(
    message: Extract<PiAgentMessage, { role: "assistant" }>,
  ): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    this.assistantIndex += 1;
    const messageId =
      message.responseId || `${this.provider}-history-assistant-${this.assistantIndex}`;
    // The stop-reason fallback applies only to messages with no signature at
    // all, and it deliberately leaves the steering flags alone: those track
    // explicit provider phases, and a derived answer must not start classifying
    // later user messages as steers.
    const derivedPhase =
      getPiAssistantMessagePhase(message) === undefined ? getPiStopReasonPhase(message) : undefined;
    for (const content of message.content) {
      if (content.type === "text" && content.text) {
        const explicitPhase = getPiTextContentPhase(content);
        if (explicitPhase) this.sawExplicitAssistantPhase = true;
        if (explicitPhase === "final_answer") this.currentTurnHasFinalAnswer = true;
        const phase = explicitPhase ?? derivedPhase;
        events.push({
          type: "timeline",
          provider: this.provider,
          item: {
            type: "assistant_message",
            text: content.text,
            messageId,
            ...(phase ? { phase } : {}),
          },
        });
        continue;
      }
      if (content.type === "thinking" && content.thinking) {
        events.push({
          type: "timeline",
          provider: this.provider,
          item: { type: "reasoning", text: content.thinking },
        });
        continue;
      }
      if (content.type === "toolCall") {
        const tracked = parseToolArgs(content.name, content.arguments);
        this.pendingToolCalls.set(content.id, tracked);
        const detail = this.mapToolDetail(content.id, tracked, null);
        if (!detail) {
          continue;
        }
        events.push({
          type: "timeline",
          provider: this.provider,
          item: {
            type: "tool_call",
            callId: this.resolveToolCallId(content.id, tracked),
            name: tracked.toolName,
            status: "running",
            detail,
            error: null,
          },
        });
      }
    }
    return events;
  }

  private mapToolResultMessage(
    message: Extract<PiAgentMessage, { role: "toolResult" }>,
  ): AgentStreamEvent | null {
    const tracked =
      this.pendingToolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
    this.pendingToolCalls.delete(message.toolCallId);
    const result = parseToolResult({ content: message.content, details: message.details });
    const detail = this.mapToolDetail(message.toolCallId, tracked, result);
    if (!detail) {
      return null;
    }
    return {
      type: "timeline",
      provider: this.provider,
      item: toToolResultTimelineItem({
        callId: this.resolveToolCallId(message.toolCallId, tracked),
        name: resolveToolCallName(tracked, result),
        isError: Boolean(message.isError),
        detail,
        errorText: extractTextFromToolResult(result) ?? "Tool call failed",
      }),
    };
  }

  private mapBashExecutionMessage(
    message: Extract<PiAgentMessage, { role: "bashExecution" }>,
  ): AgentStreamEvent {
    const detail: ToolCallDetail = {
      type: "shell",
      command: message.command,
      output: message.output,
      exitCode: message.exitCode ?? null,
    };
    return {
      type: "timeline",
      provider: this.provider,
      item: {
        type: "tool_call",
        callId: `pi-bash-${message.timestamp}`,
        name: "bash",
        status: message.cancelled ? "canceled" : "completed",
        detail,
        error: null,
      },
    };
  }

  private resolveToolCallId(toolCallId: string, toolCall: PiTrackedToolCall): string {
    return this.hooks.resolveToolCallId?.(toolCallId, toolCall) ?? toolCallId;
  }

  private mapToolDetail(
    toolCallId: string,
    toolCall: PiTrackedToolCall,
    result: PiToolResult,
  ): ToolCallDetail | null {
    const hook = this.hooks.mapToolDetail;
    return hook ? hook(toolCall, result, { toolCallId }) : mapToolDetail(toolCall, result);
  }
}

export async function* streamPiHistory(
  provider: string,
  messages: PiAgentMessage[],
  userEntries: readonly PiCapturedUserMessageEntry[] = [],
  hooks: PiHistoryMapperHooks = {},
): AsyncGenerator<AgentStreamEvent> {
  const mapper = new PiHistoryMapper(provider, userEntries, hooks);
  for (const event of mapper.mapMessages(messages)) {
    if (event) {
      yield event;
    }
  }
}

function toToolResultTimelineItem(input: {
  callId: string;
  name: string;
  isError: boolean;
  detail: ToolCallDetail;
  errorText: string;
}): AgentTimelineItem {
  if (input.isError) {
    return {
      type: "tool_call",
      callId: input.callId,
      name: input.name,
      status: "failed",
      detail: input.detail,
      error: input.errorText,
    };
  }
  return {
    type: "tool_call",
    callId: input.callId,
    name: input.name,
    status: "completed",
    detail: input.detail,
    error: null,
  };
}
