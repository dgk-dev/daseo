import { describe, expect, it } from "vitest";
import { parseAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { isHomeDirectoryPath } from "@/utils/shorten-path";
import {
  QUICK_ASK_ROUTE,
  QUICK_ASK_URL,
  resolveQuickAskServerId,
  resolveQuickAskWorkspace,
  type QuickAskWorkspaceCandidate,
} from "./quick-ask";

function workspace(
  id: string,
  workspaceDirectory: string,
  overrides: Partial<QuickAskWorkspaceCandidate> = {},
): QuickAskWorkspaceCandidate {
  return { id, workspaceDirectory, archivingAt: null, statusEnteredAt: null, ...overrides };
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

  it("prefers a host with a quick-ask workspace set", () => {
    expect(
      resolveQuickAskServerId({
        hosts,
        lastSelectionServerId: "mac",
        quickAskWorkspaces: { studio: "wks_1" },
      }),
    ).toBe("studio");
  });

  it("uses the last opened host among several set ones, then the last opened, then the first", () => {
    expect(
      resolveQuickAskServerId({
        hosts,
        lastSelectionServerId: "studio",
        quickAskWorkspaces: { mac: "a", studio: "b" },
      }),
    ).toBe("studio");
    expect(
      resolveQuickAskServerId({ hosts, lastSelectionServerId: "studio", quickAskWorkspaces: {} }),
    ).toBe("studio");
    expect(
      resolveQuickAskServerId({ hosts, lastSelectionServerId: "gone", quickAskWorkspaces: {} }),
    ).toBe("mac");
    expect(
      resolveQuickAskServerId({ hosts: [], lastSelectionServerId: null, quickAskWorkspaces: {} }),
    ).toBeNull();
  });
});

describe("resolveQuickAskWorkspace", () => {
  const home = "/Users/ddgk";

  it("opens the workspace set for the host while it still exists", () => {
    expect(
      resolveQuickAskWorkspace({
        configuredWorkspaceId: "wks_repo",
        workspaces: [workspace("wks_home", home), workspace("wks_repo", `${home}/ws/paseo`)],
        agents: [],
      }),
    ).toEqual({ kind: "workspace", workspaceId: "wks_repo", source: "setting" });
  });

  it("falls back to the most recently active home-folder workspace", () => {
    const result = resolveQuickAskWorkspace({
      configuredWorkspaceId: "wks_archived",
      workspaces: [
        workspace("wks_old", home, { statusEnteredAt: new Date("2026-10-20T00:00:00Z") }),
        workspace("wks_recent", `${home}/`),
        workspace("wks_repo", `${home}/ws/paseo`, {
          statusEnteredAt: new Date("2026-10-25T09:00:00Z"),
        }),
        workspace("wks_leaving", home, {
          archivingAt: "2026-10-25T09:00:00Z",
          statusEnteredAt: new Date("2026-10-25T09:00:00Z"),
        }),
      ],
      agents: [
        { workspaceId: "wks_recent", lastActivityAt: new Date("2026-10-24T00:00:00Z") },
        {
          workspaceId: "wks_old",
          lastActivityAt: new Date("2026-10-25T08:00:00Z"),
          archivedAt: new Date("2026-10-25T08:30:00Z"),
        },
      ],
    });
    expect(result).toEqual({ kind: "workspace", workspaceId: "wks_recent", source: "home" });
  });

  it("asks to create a home-folder workspace when none exists", () => {
    expect(
      resolveQuickAskWorkspace({
        configuredWorkspaceId: null,
        workspaces: [workspace("wks_repo", "/Users/ddgk/ws/hym")],
        agents: [],
      }),
    ).toEqual({ kind: "create" });
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
