import type { StreamItem } from "@/types/stream";

export interface ActiveCompaction {
  startedAt: Date;
  trigger?: "auto" | "manual";
}

export interface CompactionProjection {
  tail: StreamItem[];
  head: StreamItem[];
  active: ActiveCompaction | null;
}

/**
 * A manual `/compact` runs as a daemon-handled command with no foreground turn,
 * so turn liveness alone would hide its progress. Age is the second signal:
 * compaction takes minutes at most, so an older open row is abandoned work the
 * daemon will close the next time it seeds this timeline.
 */
const MAX_LIVE_COMPACTION_AGE_MS = 15 * 60 * 1_000;

function isOpenCompaction(item: StreamItem): boolean {
  return item.kind === "compaction" && item.status === "loading";
}

/**
 * Compaction progress is transient; only its result is history.
 *
 * The daemon records the start of a compaction as a timeline row because that is
 * the one ordered, resumable channel it has. That row survives a crash, a killed
 * Pi process, and a Mac that stops mid-compaction, so rendering it as a spinner
 * puts a progress indicator in permanent scrollback. Codex, OpenCode, Pi, and
 * Gemini CLI all keep the running state in a volatile status surface and commit
 * only the outcome, which is why none of them can strand one.
 *
 * So the transcript shows terminal compaction rows only, and the open row (if the
 * turn is still live) becomes footer status that disappears with the turn.
 */
export function projectCompactionPresentation(input: {
  tail: StreamItem[];
  head: StreamItem[];
  isTurnActive: boolean;
  now?: Date;
}): CompactionProjection {
  const hasOpenTail = input.tail.some(isOpenCompaction);
  const hasOpenHead = input.head.some(isOpenCompaction);
  if (!hasOpenTail && !hasOpenHead) {
    return { tail: input.tail, head: input.head, active: null };
  }

  const newestOpen = [...input.tail, ...input.head].findLast(isOpenCompaction);
  const now = input.now ?? new Date();
  const isLive =
    newestOpen?.kind === "compaction" &&
    (input.isTurnActive ||
      now.getTime() - newestOpen.timestamp.getTime() < MAX_LIVE_COMPACTION_AGE_MS);
  const active =
    isLive && newestOpen?.kind === "compaction"
      ? {
          startedAt: newestOpen.timestamp,
          ...(newestOpen.trigger ? { trigger: newestOpen.trigger } : {}),
        }
      : null;

  return {
    tail: hasOpenTail ? input.tail.filter((item) => !isOpenCompaction(item)) : input.tail,
    head: hasOpenHead ? input.head.filter((item) => !isOpenCompaction(item)) : input.head,
    active,
  };
}
