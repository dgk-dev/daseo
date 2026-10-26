import { describe, expect, it } from "vitest";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { findEmptyDraftTabs, isWorkspaceUnused } from "./discard-empty-rules";

const draft = (draftId: string): WorkspaceTab => ({
  tabId: `tab-${draftId}`,
  target: { kind: "draft", draftId },
  createdAt: 0,
});
const agent: WorkspaceTab = {
  tabId: "tab-agent",
  target: { kind: "agent", agentId: "a1" },
  createdAt: 0,
};
const terminal: WorkspaceTab = {
  tabId: "tab-term",
  target: { kind: "terminal", terminalId: "t1" },
  createdAt: 0,
};
const base = {
  workspaceKind: "directory",
  pinned: false,
  hasAgents: false,
  tabs: [draft("d1")],
  isDraftUsed: () => false,
};

describe("isWorkspaceUnused", () => {
  it("treats a fresh workspace with an empty new-agent tab as unused", () => {
    expect(isWorkspaceUnused(base)).toBe(true);
    expect(isWorkspaceUnused({ ...base, tabs: [] })).toBe(true);
  });

  it("keeps a workspace with typed text, an agent, a terminal, a pin, or the project checkout", () => {
    expect(isWorkspaceUnused({ ...base, isDraftUsed: (id) => id === "d1" })).toBe(false);
    expect(isWorkspaceUnused({ ...base, hasAgents: true })).toBe(false);
    expect(isWorkspaceUnused({ ...base, tabs: [draft("d1"), terminal] })).toBe(false);
    expect(isWorkspaceUnused({ ...base, tabs: [agent] })).toBe(false);
    expect(isWorkspaceUnused({ ...base, pinned: true })).toBe(false);
    expect(isWorkspaceUnused({ ...base, workspaceKind: "local_checkout" })).toBe(false);
  });
});

describe("findEmptyDraftTabs", () => {
  it("closes empty new-agent tabs next to real work, never the last tab", () => {
    expect(findEmptyDraftTabs([agent, draft("d1"), draft("d2")], (id) => id === "d2")).toEqual([
      draft("d1"),
    ]);
    expect(findEmptyDraftTabs([draft("d1")], () => false)).toEqual([]);
  });
});
