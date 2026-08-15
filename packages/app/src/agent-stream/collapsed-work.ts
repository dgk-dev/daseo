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
