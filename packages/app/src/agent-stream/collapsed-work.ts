import type { StreamItem } from "@/types/stream";

/**
 * Provider-neutral completed-turn projection. The canonical stream remains
 * untouched; only render output changes. Completed intermediate activity folds
 * behind one summary row, while the entire final assistant block group stays
 * visible. Expanding a row therefore restores the exact original item order.
 */

const WORK_KINDS = new Set<StreamItem["kind"]>([
  "thought",
  "tool_call",
  "todo_list",
  "activity_log",
  "compaction",
]);
const ERROR_ASSISTANT_PREFIX = /^\[(?:system )?error\]/i;

export interface CollapsedWorkResult {
  items: StreamItem[];
  /** Folded-detail count per stable completed-turn key, including expanded turns. */
  workCountByTurnKey: Map<string, number>;
  /** Final-answer anchor item id -> stable completed-turn key. */
  summaryTurnKeyByAssistantId: Map<string, string>;
  /** Stable completed-turn key -> final rendered assistant item id. */
  turnEndAssistantIdByTurnKey: Map<string, string>;
  /** Final rendered assistant item id -> stable completed-turn key. */
  turnKeyByTurnEndAssistantId: Map<string, string>;
}

export function isCollapsibleWorkItem(item: StreamItem): boolean {
  return WORK_KINDS.has(item.kind);
}

interface Turn {
  start: number;
  end: number; // exclusive
  hasUserMessage: boolean;
}

interface TurnProjection {
  turnKey: string;
  turnEndAssistantId: string;
  summaryAnchorId: string;
  hideableDetails: StreamItem[];
}

function splitTurns(items: readonly StreamItem[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === "user_message") {
      if (current) {
        current.end = index;
        turns.push(current);
      }
      current = { start: index, end: items.length, hasUserMessage: true };
      continue;
    }
    if (!current) {
      // A page can begin mid-turn. Without its user boundary, completion is
      // ambiguous, so this leading slice is never auto-folded.
      current = { start: index, end: items.length, hasUserMessage: false };
    }
  }
  if (current) turns.push(current);
  return turns;
}

function isIncompleteDetail(item: StreamItem): boolean {
  if (item.kind === "thought") return item.status === "loading";
  if (item.kind === "compaction") return item.status === "loading";
  if (item.kind !== "tool_call") return false;
  return item.payload.data.status === "running" || item.payload.data.status === "executing";
}

function mustRemainVisible(item: StreamItem): boolean {
  if (item.kind === "assistant_message") return ERROR_ASSISTANT_PREFIX.test(item.text.trimStart());
  if (item.kind === "activity_log") return item.activityType === "error";
  if (item.kind !== "tool_call") return isIncompleteDetail(item);
  return (
    item.payload.data.status === "failed" ||
    (item.payload.source === "agent" && item.payload.data.status === "canceled") ||
    isIncompleteDetail(item)
  );
}

function getAssistantIndices(items: readonly StreamItem[], turn: Turn): number[] {
  const assistantIndices: number[] = [];
  for (let index = turn.start; index < turn.end; index += 1) {
    if (items[index]?.kind === "assistant_message") assistantIndices.push(index);
  }
  return assistantIndices;
}

function getFinalGroupIndices(
  items: readonly StreamItem[],
  assistantIndices: readonly number[],
  lastAssistantIndex: number,
): Set<number> {
  const lastAssistant = items[lastAssistantIndex];
  const blockGroupId =
    lastAssistant?.kind === "assistant_message" ? lastAssistant.blockGroupId : undefined;
  if (blockGroupId) {
    // Markdown streaming may promote one logical assistant response into
    // several render items. blockGroupId is authoritative when present;
    // messageId is not, because providers can reuse one message id before and
    // after tool activity.
    return new Set(
      assistantIndices.filter((index) => {
        const assistant = items[index];
        return assistant?.kind === "assistant_message" && assistant.blockGroupId === blockGroupId;
      }),
    );
  }

  // Older/custom providers may emit the final response as adjacent assistant
  // rows without grouping metadata. Preserve the entire contiguous suffix;
  // a tool/thought/activity boundary still separates intermediate commentary.
  const finalGroupIndices = new Set([lastAssistantIndex]);
  for (let index = lastAssistantIndex - 1; index >= 0; index -= 1) {
    if (items[index]?.kind !== "assistant_message") break;
    finalGroupIndices.add(index);
  }
  return finalGroupIndices;
}

function getTurnDetails(
  items: readonly StreamItem[],
  turn: Turn,
  finalGroupIndices: ReadonlySet<number>,
): StreamItem[] {
  const details: StreamItem[] = [];
  for (let index = turn.start; index < turn.end; index += 1) {
    const item = items[index]!;
    const isIntermediateAssistant =
      item.kind === "assistant_message" && !finalGroupIndices.has(index);
    if (isIntermediateAssistant || WORK_KINDS.has(item.kind)) details.push(item);
  }
  return details;
}

function projectTurn(items: readonly StreamItem[], turn: Turn): TurnProjection | null {
  if (!turn.hasUserMessage) return null;

  const assistantIndices = getAssistantIndices(items, turn);
  const lastAssistantIndex = assistantIndices.at(-1);
  if (lastAssistantIndex === undefined) return null;
  const lastAssistant = items[lastAssistantIndex];
  if (!lastAssistant || lastAssistant.kind !== "assistant_message") return null;
  const hasExceptionalOutcome = assistantIndices.some((index) => {
    const assistant = items[index];
    return (
      assistant?.kind === "assistant_message" &&
      (assistant.turnOutcome === "failed" || assistant.turnOutcome === "canceled")
    );
  });
  if (hasExceptionalOutcome) return null;

  const finalGroupIndices = getFinalGroupIndices(items, assistantIndices, lastAssistantIndex);
  const details = getTurnDetails(items, turn, finalGroupIndices);
  // Loading thoughts, running tools, and loading compaction markers indicate a
  // partial projection even if agent liveness briefly reports idle.
  if (details.some(isIncompleteDetail)) return null;

  const hideableDetails = details.filter((item) => !mustRemainVisible(item));
  if (hideableDetails.length === 0) return null;

  const summaryAnchor = items[Math.min(...finalGroupIndices)];
  if (!summaryAnchor || summaryAnchor.kind !== "assistant_message") return null;
  return {
    // Provider message identity survives block promotion and canonical
    // hydration more reliably than a renderer-row id, preserving manual
    // expansion state while the transcript reconciles.
    turnKey: lastAssistant.messageId ?? lastAssistant.blockGroupId ?? lastAssistant.id,
    turnEndAssistantId: lastAssistant.id,
    summaryAnchorId: summaryAnchor.id,
    hideableDetails,
  };
}

export interface CollapsedStreamResult {
  tail: StreamItem[];
  head: StreamItem[];
  workCountByTurnKey: Map<string, number>;
  summaryTurnKeyByAssistantId: Map<string, string>;
  turnEndAssistantIdByTurnKey: Map<string, string>;
  turnKeyByTurnEndAssistantId: Map<string, string>;
}

/**
 * Collapse across the tail/head boundary. While a turn is active only settled
 * history collapses (the in-flight turn streams fully); once idle the buffers
 * are folded together so a turn spanning both buffers gets one summary row.
 */
export function collapseCompletedWorkStream(input: {
  tail: StreamItem[];
  head: StreamItem[];
  expandedTurnKeys: ReadonlySet<string>;
  isTurnActive: boolean;
}): CollapsedStreamResult {
  const { tail, head, expandedTurnKeys, isTurnActive } = input;
  if (isTurnActive) {
    const collapsedTail = collapseCompletedWork({
      items: tail,
      expandedTurnKeys,
      keepLastTurnExpanded: true,
    });
    return {
      tail: collapsedTail.items,
      head,
      workCountByTurnKey: collapsedTail.workCountByTurnKey,
      summaryTurnKeyByAssistantId: collapsedTail.summaryTurnKeyByAssistantId,
      turnEndAssistantIdByTurnKey: collapsedTail.turnEndAssistantIdByTurnKey,
      turnKeyByTurnEndAssistantId: collapsedTail.turnKeyByTurnEndAssistantId,
    };
  }
  if (head.length === 0) {
    const collapsedTail = collapseCompletedWork({
      items: tail,
      expandedTurnKeys,
      keepLastTurnExpanded: false,
    });
    return {
      tail: collapsedTail.items,
      head,
      workCountByTurnKey: collapsedTail.workCountByTurnKey,
      summaryTurnKeyByAssistantId: collapsedTail.summaryTurnKeyByAssistantId,
      turnEndAssistantIdByTurnKey: collapsedTail.turnEndAssistantIdByTurnKey,
      turnKeyByTurnEndAssistantId: collapsedTail.turnKeyByTurnEndAssistantId,
    };
  }
  const headItems = new Set(head);
  const combined = collapseCompletedWork({
    items: [...tail, ...head],
    expandedTurnKeys,
    keepLastTurnExpanded: false,
  });
  const tailOut: StreamItem[] = [];
  const headOut: StreamItem[] = [];
  for (const item of combined.items) {
    (headItems.has(item) ? headOut : tailOut).push(item);
  }
  return {
    tail: tailOut,
    head: headOut,
    workCountByTurnKey: combined.workCountByTurnKey,
    summaryTurnKeyByAssistantId: combined.summaryTurnKeyByAssistantId,
    turnEndAssistantIdByTurnKey: combined.turnEndAssistantIdByTurnKey,
    turnKeyByTurnEndAssistantId: combined.turnKeyByTurnEndAssistantId,
  };
}

export function collapseCompletedWork(input: {
  items: StreamItem[];
  expandedTurnKeys: ReadonlySet<string>;
  /** Never summarize the trailing settled slice while its turn is active. */
  keepLastTurnExpanded: boolean;
}): CollapsedWorkResult {
  const { items, expandedTurnKeys, keepLastTurnExpanded } = input;
  const workCountByTurnKey = new Map<string, number>();
  const summaryTurnKeyByAssistantId = new Map<string, string>();
  const turnEndAssistantIdByTurnKey = new Map<string, string>();
  const turnKeyByTurnEndAssistantId = new Map<string, string>();
  if (items.length === 0) {
    return {
      items,
      workCountByTurnKey,
      summaryTurnKeyByAssistantId,
      turnEndAssistantIdByTurnKey,
      turnKeyByTurnEndAssistantId,
    };
  }

  const turns = splitTurns(items);
  const hidden = new Set<StreamItem>();
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    if (keepLastTurnExpanded && turnIndex === turns.length - 1) continue;
    const projection = projectTurn(items, turns[turnIndex]!);
    if (!projection) continue;

    workCountByTurnKey.set(projection.turnKey, projection.hideableDetails.length);
    summaryTurnKeyByAssistantId.set(projection.summaryAnchorId, projection.turnKey);
    turnEndAssistantIdByTurnKey.set(projection.turnKey, projection.turnEndAssistantId);
    turnKeyByTurnEndAssistantId.set(projection.turnEndAssistantId, projection.turnKey);
    if (expandedTurnKeys.has(projection.turnKey)) continue;
    for (const item of projection.hideableDetails) hidden.add(item);
  }

  if (hidden.size === 0) {
    return {
      items,
      workCountByTurnKey,
      summaryTurnKeyByAssistantId,
      turnEndAssistantIdByTurnKey,
      turnKeyByTurnEndAssistantId,
    };
  }
  return {
    items: items.filter((item) => !hidden.has(item)),
    workCountByTurnKey,
    summaryTurnKeyByAssistantId,
    turnEndAssistantIdByTurnKey,
    turnKeyByTurnEndAssistantId,
  };
}
