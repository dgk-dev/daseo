import { isHomeDirectoryPath } from "@/utils/shorten-path";

// Daseo delta 64: holding the Galaxy side button (Daseo as the digital assistant), the static
// "Quick ask" app shortcut, and `adb shell am start -d paseo://quick-ask` all open this URL.
// Expo Router maps it to the root `/quick-ask` route. It is not an agent URL: the stable
// `paseo://h/{serverId}/agent/{agentId}` format stays untouched (docs/expo-router.md).
export const QUICK_ASK_URL = "paseo://quick-ask";
export const QUICK_ASK_ROUTE = "/quick-ask";
// The daemon expands `~` to its user's home directory; used only when the host has no
// home-folder project yet, so the daemon finds or creates it.
export const QUICK_ASK_HOME_DIRECTORY = "~";

export interface QuickAskProjectCandidate {
  projectId: string;
  projectRootPath: string;
}

// Every quick ask creates a new workspace in this project and opens a new agent in it, the same
// thing the sidebar's "new workspace" row does (David-Daniel, 2026-10-25). The workspace has no
// title, so the daemon names it from the first prompt.
export type QuickAskProjectTarget =
  | { kind: "project"; projectId: string; directory: string; source: "setting" | "home" }
  | { kind: "homeDirectory" };

/**
 * The host a quick ask goes to: one with a quick-ask project set (the last-used host when
 * several are set), else the host of the last opened workspace, else the first host.
 */
export function resolveQuickAskServerId(input: {
  hosts: readonly { serverId: string }[];
  lastSelectionServerId: string | null;
  quickAskProjects: Readonly<Record<string, string>>;
}): string | null {
  const known = input.hosts.map((host) => host.serverId);
  const last =
    input.lastSelectionServerId && known.includes(input.lastSelectionServerId)
      ? input.lastSelectionServerId
      : null;
  const configured = known.filter((serverId) => Boolean(input.quickAskProjects[serverId]));
  if (configured.length > 0) {
    return last && configured.includes(last) ? last : (configured[0] ?? null);
  }
  return last ?? known[0] ?? null;
}

/** The host's projects rooted at the home folder, in a stable order. */
export function listHomeProjects<Project extends QuickAskProjectCandidate>(
  projects: Iterable<Project>,
): Project[] {
  return Array.from(projects)
    .filter((project) => isHomeDirectoryPath(project.projectRootPath))
    .sort((left, right) => left.projectId.localeCompare(right.projectId));
}

/**
 * Where the new quick-ask workspace is created: the project set for the host when it still
 * exists, otherwise the home-folder project, otherwise the home folder itself.
 */
export function resolveQuickAskProject(input: {
  configuredProjectId: string | null;
  projects: Iterable<QuickAskProjectCandidate>;
}): QuickAskProjectTarget {
  const projects = Array.from(input.projects);
  const configured = input.configuredProjectId
    ? projects.find((project) => project.projectId === input.configuredProjectId)
    : undefined;
  if (configured) {
    return {
      kind: "project",
      projectId: configured.projectId,
      directory: configured.projectRootPath,
      source: "setting",
    };
  }
  const home = listHomeProjects(projects)[0];
  if (home) {
    return {
      kind: "project",
      projectId: home.projectId,
      directory: home.projectRootPath,
      source: "home",
    };
  }
  return { kind: "homeDirectory" };
}

export type QuickAskContinueTarget =
  | { kind: "agent"; serverId: string; workspaceId: string; agentId: string }
  | { kind: "draft"; serverId: string; workspaceId: string; draftId: string };

/**
 * Holding the side button while Daseo already shows a session dictates into that session instead
 * of opening a new one (David-Daniel, 2026-10-25). Android marks the launch `from=foreground` when
 * Daseo was on screen; on a compact layout the session must also be the panel in view, so a
 * press while the agent list is open still opens a new session.
 */
export function resolveQuickAskContinueTarget(input: {
  fromForeground: boolean;
  isCompact: boolean;
  mobilePanelTarget: "agent-list" | "agent" | "file-explorer";
  lastSelection: { serverId: string; workspaceId: string } | null;
  focusedTabTarget: { kind: string; agentId?: string; draftId?: string } | null;
}): QuickAskContinueTarget | null {
  const { lastSelection, focusedTabTarget } = input;
  if (!input.fromForeground || !lastSelection || !focusedTabTarget) {
    return null;
  }
  if (input.isCompact && input.mobilePanelTarget !== "agent") {
    return null;
  }
  if (focusedTabTarget.kind === "agent" && focusedTabTarget.agentId) {
    return { kind: "agent", ...lastSelection, agentId: focusedTabTarget.agentId };
  }
  if (focusedTabTarget.kind === "draft" && focusedTabTarget.draftId) {
    return { kind: "draft", ...lastSelection, draftId: focusedTabTarget.draftId };
  }
  return null;
}
