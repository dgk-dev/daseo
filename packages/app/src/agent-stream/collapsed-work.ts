import type { StreamItem } from "@/types/stream";

/**
 * Codex-style collapsed history: once a turn has completed, its work items
 * (thoughts, tool calls, todo lists, activity logs) are hidden so the
 * transcript reads as user prompts and assistant answers only. Each collapsed
 * turn can be re-expanded from its "Worked for …" footer.
 *
 * A turn is keyed by the id of its last assistant message — the same item the
 * layout attaches the completed-turn footer to, which is where the expand
 * control lives.
 */

const WORK_KINDS = new Set<StreamItem["kind"]>([
  "thought",
  "tool_call",
  "todo_list",
  "activity_log",
]);

export interface CollapsedWorkResult {
  items: StreamItem[];
  /** Work-item count per collapsible turn key, including expanded turns. */
  workCountByTurnKey: Map<string, number>;
}

export function isCollapsibleWorkItem(item: StreamItem): boolean {
  return WORK_KINDS.has(item.kind);
}

interface Turn {
  start: number;
  end: number; // exclusive
  turnKey: string | null; // last assistant message id in the turn
  workCount: number;
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
      current = { start: index, end: items.length, turnKey: null, workCount: 0 };
      continue;
    }
    if (!current) {
      // Leading partial turn (older pages may start mid-turn).
      current = { start: index, end: items.length, turnKey: null, workCount: 0 };
    }
    if (item.kind === "assistant_message") {
      current.turnKey = item.id;
    } else if (WORK_KINDS.has(item.kind)) {
      current.workCount += 1;
    }
  }
  if (current) {
    turns.push(current);
  }
  return turns;
}

export interface CollapsedStreamResult {
  tail: StreamItem[];
  head: StreamItem[];
  workCountByTurnKey: Map<string, number>;
}

/**
 * Collapse across the tail/head boundary. While a turn is active only settled
 * history collapses (the in-flight turn streams fully); once idle the buffers
 * are folded together so a turn whose user message sits in the tail and whose
 * final assistant message is still in the head collapses as one turn with a
 * single summary row.
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
  return { tail: tailOut, head: headOut, workCountByTurnKey: combined.workCountByTurnKey };
}

export function collapseCompletedWork(input: {
  items: StreamItem[];
  expandedTurnKeys: ReadonlySet<string>;
  /**
   * When the agent is mid-turn, settled items of the in-flight turn can
   * already live in the history array; never collapse the trailing turn then.
   */
  keepLastTurnExpanded: boolean;
}): CollapsedWorkResult {
  const { items, expandedTurnKeys, keepLastTurnExpanded } = input;
  const workCountByTurnKey = new Map<string, number>();
  if (items.length === 0) {
    return { items, workCountByTurnKey };
  }

  const turns = splitTurns(items);
  const hidden = new Set<StreamItem>();
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex]!;
    // A turn without an assistant message never completed (aborted or still
    // streaming); leave its activity visible so nothing is silently lost.
    if (!turn.turnKey || turn.workCount === 0) {
      continue;
    }
    workCountByTurnKey.set(turn.turnKey, turn.workCount);
    if (keepLastTurnExpanded && turnIndex === turns.length - 1) {
      continue;
    }
    if (expandedTurnKeys.has(turn.turnKey)) {
      continue;
    }
    for (let index = turn.start; index < turn.end; index += 1) {
      const item = items[index]!;
      if (WORK_KINDS.has(item.kind)) {
        hidden.add(item);
      }
    }
  }

  if (hidden.size === 0) {
    return { items, workCountByTurnKey };
  }
  return {
    items: items.filter((item) => !hidden.has(item)),
    workCountByTurnKey,
  };
}
