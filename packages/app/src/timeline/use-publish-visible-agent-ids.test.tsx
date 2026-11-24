// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { usePublishVisibleAgentIds } from "./use-publish-visible-agent-ids";
import type { ViewedTimelineUiBridge } from "./viewed-timeline-sync";

// Mirrors the source registry of `createViewedTimelineSync`: an empty list removes the source.
function createFakeSync() {
  const sources = new Map<string, string[]>();
  const calls: Array<{ sourceId: string; agentIds: string[] }> = [];
  const sync: ViewedTimelineUiBridge = {
    replaceVisibleAgentIds(sourceId: string, agentIds: string[]) {
      calls.push({ sourceId, agentIds: [...agentIds] });
      if (agentIds.length === 0) sources.delete(sourceId);
      else sources.set(sourceId, [...agentIds]);
    },
    subscribe: () => () => {},
    getAgentTimelineStatus: () => "ready",
    retryVisibleAgentTimeline: () => {},
  };
  const visible = () => [...new Set([...sources.values()].flat())].sort();
  return { sync, sources, calls, visible };
}

function Publisher({
  sync,
  persistenceKey,
  agentIds,
}: {
  sync: ViewedTimelineUiBridge | null;
  persistenceKey: string | null;
  agentIds: string[];
}) {
  usePublishVisibleAgentIds(sync, persistenceKey, agentIds);
  return null;
}

function CompactParent({ children }: { children: ReactNode }) {
  return <section>{children}</section>;
}

function WideParent({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}

const AGENTS_A = ["agent-a"];
const AGENTS_AB = ["agent-a", "agent-b"];

describe("usePublishVisibleAgentIds", () => {
  it("keeps the visible agents when the screen remounts under another parent in one commit", () => {
    const fake = createFakeSync();
    const tree = (compact: boolean) =>
      compact ? (
        <CompactParent>
          <Publisher sync={fake.sync} persistenceKey="host:ws" agentIds={AGENTS_A} />
        </CompactParent>
      ) : (
        <WideParent>
          <Publisher sync={fake.sync} persistenceKey="host:ws" agentIds={AGENTS_A} />
        </WideParent>
      );
    const { rerender, unmount } = render(tree(true));
    expect(fake.visible()).toEqual(["agent-a"]);

    act(() => rerender(tree(false)));
    expect(fake.visible()).toEqual(["agent-a"]);

    act(() => rerender(tree(true)));
    expect(fake.visible()).toEqual(["agent-a"]);

    unmount();
    expect(fake.visible()).toEqual([]);
    expect(fake.sources.size).toBe(0);
  });

  it("clears only its own source when two screens share a workspace key", () => {
    const fake = createFakeSync();
    const tree = (showFirst: boolean) => (
      <>
        {showFirst ? (
          <Publisher sync={fake.sync} persistenceKey="host:ws" agentIds={AGENTS_A} />
        ) : null}
        <Publisher sync={fake.sync} persistenceKey="host:ws" agentIds={AGENTS_AB} />
      </>
    );
    const { rerender, unmount } = render(tree(true));
    expect(fake.visible()).toEqual(["agent-a", "agent-b"]);

    act(() => rerender(tree(false)));
    expect(fake.visible()).toEqual(["agent-a", "agent-b"]);

    unmount();
    expect(fake.visible()).toEqual([]);
  });

  it("does not publish an empty list on ordinary re-renders", () => {
    const fake = createFakeSync();
    const { rerender, unmount } = render(
      <Publisher sync={fake.sync} persistenceKey="host:ws" agentIds={AGENTS_A} />,
    );
    act(() =>
      rerender(<Publisher sync={fake.sync} persistenceKey="host:ws" agentIds={AGENTS_AB} />),
    );
    act(() =>
      rerender(<Publisher sync={fake.sync} persistenceKey="host:ws" agentIds={AGENTS_AB} />),
    );
    expect(fake.calls.map((call) => call.agentIds)).toEqual([AGENTS_A, AGENTS_AB]);
    expect(fake.visible()).toEqual(["agent-a", "agent-b"]);
    unmount();
  });

  it("moves the ids to a replacement sync object", () => {
    const first = createFakeSync();
    const second = createFakeSync();
    const { rerender, unmount } = render(
      <Publisher sync={first.sync} persistenceKey="host:ws" agentIds={AGENTS_A} />,
    );
    act(() =>
      rerender(<Publisher sync={second.sync} persistenceKey="host:ws" agentIds={AGENTS_A} />),
    );
    expect(first.visible()).toEqual([]);
    expect(second.visible()).toEqual(["agent-a"]);
    unmount();
    expect(second.visible()).toEqual([]);
  });

  it("publishes nothing without a workspace key or a sync", () => {
    const fake = createFakeSync();
    const { rerender, unmount } = render(
      <Publisher sync={fake.sync} persistenceKey={null} agentIds={AGENTS_A} />,
    );
    act(() => rerender(<Publisher sync={null} persistenceKey="host:ws" agentIds={AGENTS_A} />));
    expect(fake.calls).toEqual([]);
    unmount();
  });
});
