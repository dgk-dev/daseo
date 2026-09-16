import { describe, expect, it } from "vitest";

import { projectCompactionPresentation } from "./compaction-presentation";
import type { StreamItem } from "@/types/stream";

function compaction(
  id: string,
  status: "loading" | "completed",
  timestamp: string,
  trigger: "auto" | "manual" = "auto",
): StreamItem {
  return {
    kind: "compaction",
    id,
    status,
    trigger,
    timestamp: new Date(timestamp),
  };
}

function assistant(id: string, timestamp: string): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: "done",
    timestamp: new Date(timestamp),
  };
}

describe("projectCompactionPresentation", () => {
  it("returns the same arrays when no compaction is open", () => {
    const tail = [assistant("a1", "2026-09-16T00:00:00.000Z")];
    const head: StreamItem[] = [];

    const projection = projectCompactionPresentation({ tail, head, isTurnActive: true });

    expect(projection.tail).toBe(tail);
    expect(projection.head).toBe(head);
    expect(projection.active).toBeNull();
  });

  it("keeps an open compaction out of the transcript and reports it as status", () => {
    const projection = projectCompactionPresentation({
      tail: [
        assistant("a1", "2026-09-16T00:00:00.000Z"),
        compaction("c1", "loading", "2026-09-16T00:01:00.000Z", "manual"),
      ],
      head: [],
      isTurnActive: true,
      now: new Date("2026-09-16T00:01:10.000Z"),
    });

    expect(projection.tail.map((item) => item.id)).toEqual(["a1"]);
    expect(projection.active).toEqual({
      startedAt: new Date("2026-09-16T00:01:00.000Z"),
      trigger: "manual",
    });
  });

  it("drops an abandoned compaction instead of showing progress on an idle turn", () => {
    const projection = projectCompactionPresentation({
      tail: [compaction("c1", "loading", "2026-09-15T15:16:57.000Z")],
      head: [],
      isTurnActive: false,
      now: new Date("2026-09-16T00:01:00.000Z"),
    });

    expect(projection.tail).toEqual([]);
    expect(projection.active).toBeNull();
  });

  it("still reports a fresh manual compaction that runs without a foreground turn", () => {
    const projection = projectCompactionPresentation({
      tail: [compaction("c1", "loading", "2026-09-16T00:00:30.000Z", "manual")],
      head: [],
      isTurnActive: false,
      now: new Date("2026-09-16T00:01:00.000Z"),
    });

    expect(projection.tail).toEqual([]);
    expect(projection.active).toEqual({
      startedAt: new Date("2026-09-16T00:00:30.000Z"),
      trigger: "manual",
    });
  });

  it("reports the newest open compaction when an older one was never closed", () => {
    const projection = projectCompactionPresentation({
      tail: [
        compaction("c1", "loading", "2026-09-15T15:16:57.000Z"),
        compaction("c2", "loading", "2026-09-16T00:01:04.000Z"),
      ],
      head: [],
      isTurnActive: true,
      now: new Date("2026-09-16T00:01:10.000Z"),
    });

    expect(projection.tail).toEqual([]);
    expect(projection.active?.startedAt).toEqual(new Date("2026-09-16T00:01:04.000Z"));
  });

  it("keeps terminal compaction rows, including failed ones", () => {
    const failed: StreamItem = {
      ...compaction("c1", "completed", "2026-09-16T00:01:04.000Z"),
      outcome: "failed",
      error: "Prompt is too long",
    } as StreamItem;

    const projection = projectCompactionPresentation({
      tail: [failed],
      head: [compaction("c2", "loading", "2026-09-16T00:05:00.000Z")],
      isTurnActive: true,
    });

    expect(projection.tail).toEqual([failed]);
    expect(projection.head).toEqual([]);
  });
});
