import { describe, expect, it } from "vitest";
import { parseAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { isHomeDirectoryPath } from "@/utils/shorten-path";
import {
  QUICK_ASK_ROUTE,
  QUICK_ASK_URL,
  resolveQuickAskContinueTarget,
  resolveQuickAskProject,
  resolveQuickAskServerId,
} from "./quick-ask";

function project(projectId: string, projectRootPath: string) {
  return { projectId, projectRootPath };
}

describe("quick-ask URL", () => {
  it("is its own route and never parses as a stable agent link", () => {
    const url = new URL(QUICK_ASK_URL);
    expect(url.protocol).toBe("paseo:");
    // Expo Router reads the URL host as the first path segment.
    expect(`/${url.host}${url.pathname}`.replace(/\/$/, "")).toBe(QUICK_ASK_ROUTE);
    expect(parseAgentDeepLink(QUICK_ASK_URL)).toBeNull();
  });
});

describe("resolveQuickAskServerId", () => {
  const hosts = [{ serverId: "mac" }, { serverId: "studio" }];

  it("prefers a host with a quick-ask project set", () => {
    expect(
      resolveQuickAskServerId({
        hosts,
        lastSelectionServerId: "mac",
        quickAskProjects: { studio: "wks_1" },
      }),
    ).toBe("studio");
  });

  it("uses the last opened host among several set ones, then the last opened, then the first", () => {
    expect(
      resolveQuickAskServerId({
        hosts,
        lastSelectionServerId: "studio",
        quickAskProjects: { mac: "a", studio: "b" },
      }),
    ).toBe("studio");
    expect(
      resolveQuickAskServerId({ hosts, lastSelectionServerId: "studio", quickAskProjects: {} }),
    ).toBe("studio");
    expect(
      resolveQuickAskServerId({ hosts, lastSelectionServerId: "gone", quickAskProjects: {} }),
    ).toBe("mac");
    expect(
      resolveQuickAskServerId({ hosts: [], lastSelectionServerId: null, quickAskProjects: {} }),
    ).toBeNull();
  });
});

describe("resolveQuickAskProject", () => {
  const home = "/Users/ddgk";

  it("creates the new workspace in the project set for the host while it still exists", () => {
    expect(
      resolveQuickAskProject({
        configuredProjectId: "prj_repo",
        projects: [project("prj_home", home), project("prj_repo", `${home}/ws/paseo`)],
      }),
    ).toEqual({
      kind: "project",
      projectId: "prj_repo",
      directory: `${home}/ws/paseo`,
      source: "setting",
    });
  });

  it("falls back to the home-folder project, never a project under it", () => {
    expect(
      resolveQuickAskProject({
        configuredProjectId: "prj_gone",
        projects: [project("prj_repo", `${home}/ws/hym`), project("prj_home", `${home}/`)],
      }),
    ).toEqual({ kind: "project", projectId: "prj_home", directory: `${home}/`, source: "home" });
  });

  it("uses the home folder itself when the host has no home-folder project", () => {
    expect(
      resolveQuickAskProject({
        configuredProjectId: null,
        projects: [project("prj_repo", "/Users/ddgk/ws/hym")],
      }),
    ).toEqual({ kind: "homeDirectory" });
  });
});

describe("resolveQuickAskContinueTarget", () => {
  const lastSelection = { serverId: "mac", workspaceId: "wks_1" };
  const agentTab = { kind: "agent", agentId: "agent_1" };

  it("dictates into the session on screen when Daseo was already in front", () => {
    expect(
      resolveQuickAskContinueTarget({
        fromForeground: true,
        isCompact: true,
        mobilePanelTarget: "agent",
        lastSelection,
        focusedTabTarget: agentTab,
      }),
    ).toEqual({ kind: "agent", serverId: "mac", workspaceId: "wks_1", agentId: "agent_1" });
    expect(
      resolveQuickAskContinueTarget({
        fromForeground: true,
        isCompact: false,
        mobilePanelTarget: "agent-list",
        lastSelection,
        focusedTabTarget: { kind: "draft", draftId: "draft_1" },
      }),
    ).toEqual({ kind: "draft", serverId: "mac", workspaceId: "wks_1", draftId: "draft_1" });
  });

  it("opens a new session from the background, the agent list, or a non-chat tab", () => {
    const base = {
      fromForeground: true,
      isCompact: true,
      mobilePanelTarget: "agent" as const,
      lastSelection,
      focusedTabTarget: agentTab,
    };
    expect(resolveQuickAskContinueTarget({ ...base, fromForeground: false })).toBeNull();
    expect(resolveQuickAskContinueTarget({ ...base, mobilePanelTarget: "agent-list" })).toBeNull();
    expect(
      resolveQuickAskContinueTarget({ ...base, focusedTabTarget: { kind: "terminal" } }),
    ).toBeNull();
    expect(resolveQuickAskContinueTarget({ ...base, lastSelection: null })).toBeNull();
  });
});

describe("isHomeDirectoryPath", () => {
  it("matches only the home directory itself", () => {
    expect(isHomeDirectoryPath("/Users/ddgk")).toBe(true);
    expect(isHomeDirectoryPath("/home/dev/")).toBe(true);
    expect(isHomeDirectoryPath("/Users/ddgk/ws")).toBe(false);
    expect(isHomeDirectoryPath("/Users")).toBe(false);
    expect(isHomeDirectoryPath("")).toBe(false);
  });
});
