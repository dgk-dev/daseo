import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { buildAgentLsFetchOptions, toListItem } from "./ls.js";

describe("buildAgentLsFetchOptions", () => {
  it("fetches active agents by default", () => {
    expect(buildAgentLsFetchOptions({})).toEqual({
      scope: "active",
    });
  });

  it("keeps label and thinking filters within the active scope", () => {
    expect(
      buildAgentLsFetchOptions({
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      scope: "active",
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });

  it("fetches global non-archived agents for -g", () => {
    expect(buildAgentLsFetchOptions({ global: true })).toEqual({});
  });

  it("keeps -a within the active scope", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      scope: "active",
      filter: {
        includeArchived: true,
      },
    });
  });

  it("fetches all global agents for -a -g", () => {
    expect(buildAgentLsFetchOptions({ all: true, global: true })).toEqual({
      filter: {
        includeArchived: true,
      },
    });
  });

  it("applies filters to global queries", () => {
    expect(
      buildAgentLsFetchOptions({
        global: true,
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });
});

describe("toListItem", () => {
  const snapshot = {
    id: "0123456789abcdef",
    title: "deploy",
    provider: "pi",
    model: "pi-claude/claude-opus-5-5",
    status: "idle",
    cwd: "/tmp/x",
    createdAt: new Date().toISOString(),
  } as unknown as AgentSnapshotPayload;

  it("reports pending background waits, zero when the daemon sends none", () => {
    expect(toListItem(snapshot).backgroundWaits).toBe(0);
    expect(
      toListItem({
        ...snapshot,
        backgroundWaits: { pending: 2, labels: ["web build"] },
      } as AgentSnapshotPayload).backgroundWaits,
    ).toBe(2);
  });
});
