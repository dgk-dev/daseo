import { describe, expect, it } from "vitest";
import {
  createDefaultLayout,
  focusTabInLayout,
  openTabInLayoutBackground,
  openTabInLayoutFocused,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { resolveViewedAgentId, resolveWorkspaceViewedAgentId } from "./viewed-agent";

function openFocused(layout: WorkspaceLayout, target: WorkspaceTabTarget) {
  return openTabInLayoutFocused({ layout, target, now: 1 });
}

describe("resolveViewedAgentId", () => {
  it("reads the agent of an agent tab and nothing from other tabs", () => {
    const agentTarget: WorkspaceTabTarget = { kind: "agent", agentId: "agent-a" };
    expect(resolveViewedAgentId({ key: "k", tabId: "t", kind: "agent", target: agentTarget })).toBe(
      "agent-a",
    );
    const terminalTarget: WorkspaceTabTarget = { kind: "terminal", terminalId: "term-1" };
    expect(
      resolveViewedAgentId({ key: "k", tabId: "t", kind: "terminal", target: terminalTarget }),
    ).toBeNull();
    expect(resolveViewedAgentId(null)).toBeNull();
  });
});

describe("resolveWorkspaceViewedAgentId", () => {
  it("has no viewed agent without a layout or with an empty one", () => {
    expect(resolveWorkspaceViewedAgentId(null)).toBeNull();
    expect(resolveWorkspaceViewedAgentId(createDefaultLayout())).toBeNull();
  });

  it("reads the focused pane's active tab", () => {
    const first = openFocused(createDefaultLayout(), { kind: "agent", agentId: "agent-a" });
    const second = openFocused(first.layout, { kind: "agent", agentId: "agent-b" });
    expect(resolveWorkspaceViewedAgentId(second.layout)).toBe("agent-b");

    const refocused = focusTabInLayout({ layout: second.layout, tabId: first.tabId });
    expect(refocused).not.toBeNull();
    expect(resolveWorkspaceViewedAgentId(refocused)).toBe("agent-a");
  });

  it("ignores a tab opened in the background", () => {
    const first = openFocused(createDefaultLayout(), { kind: "agent", agentId: "agent-a" });
    const background = openTabInLayoutBackground({
      layout: first.layout,
      target: { kind: "agent", agentId: "agent-b" },
      now: 2,
    });
    expect(resolveWorkspaceViewedAgentId(background.layout)).toBe("agent-a");
  });

  it("has no viewed agent when the active tab is not an agent session", () => {
    const agent = openFocused(createDefaultLayout(), { kind: "agent", agentId: "agent-a" });
    const terminal = openFocused(agent.layout, { kind: "terminal", terminalId: "term-1" });
    expect(resolveWorkspaceViewedAgentId(terminal.layout)).toBeNull();
  });
});
