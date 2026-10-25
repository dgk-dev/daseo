import { isHomeDirectoryPath } from "@/utils/shorten-path";

// Daseo delta 64: holding the Galaxy side button (Daseo as the digital assistant), the static
// "Quick ask" app shortcut, and `adb shell am start -d paseo://quick-ask` all open this URL.
// Expo Router maps it to the root `/quick-ask` route. It is not an agent URL: the stable
// `paseo://h/{serverId}/agent/{agentId}` format stays untouched (docs/expo-router.md).
export const QUICK_ASK_URL = "paseo://quick-ask";
export const QUICK_ASK_ROUTE = "/quick-ask";
// The owner's call: a home-folder workspace created for quick ask carries this title.
export const QUICK_ASK_WORKSPACE_TITLE = "빠른 질문";
// The daemon expands `~` to its user's home directory when it creates the workspace.
export const QUICK_ASK_WORKSPACE_DIRECTORY = "~";

export interface QuickAskWorkspaceCandidate {
  id: string;
  workspaceDirectory: string;
  archivingAt: string | null;
  statusEnteredAt: Date | null;
}

export interface QuickAskAgentActivity {
  workspaceId?: string;
  lastActivityAt: Date;
  archivedAt?: Date | null;
}

export type QuickAskWorkspaceTarget =
  | { kind: "workspace"; workspaceId: string; source: "setting" | "home" }
  | { kind: "create" };

/**
 * The host a quick ask goes to: one with a quick-ask workspace set (the last-used host when
 * several are set), else the host of the last opened workspace, else the first host.
 */
export function resolveQuickAskServerId(input: {
  hosts: readonly { serverId: string }[];
  lastSelectionServerId: string | null;
  quickAskWorkspaces: Readonly<Record<string, string>>;
}): string | null {
  const known = input.hosts.map((host) => host.serverId);
  const last =
    input.lastSelectionServerId && known.includes(input.lastSelectionServerId)
      ? input.lastSelectionServerId
      : null;
  const configured = known.filter((serverId) => Boolean(input.quickAskWorkspaces[serverId]));
  if (configured.length > 0) {
    return last && configured.includes(last) ? last : (configured[0] ?? null);
  }
  return last ?? known[0] ?? null;
}

function lastActivityOf(
  workspace: QuickAskWorkspaceCandidate,
  agents: readonly QuickAskAgentActivity[],
): number {
  let latest = workspace.statusEnteredAt?.getTime() ?? 0;
  for (const agent of agents) {
    if (agent.workspaceId !== workspace.id || agent.archivedAt) {
      continue;
    }
    latest = Math.max(latest, agent.lastActivityAt.getTime());
  }
  return latest;
}

/** The home-folder workspaces of a host, most recently active first. */
export function listHomeWorkspaces<Workspace extends QuickAskWorkspaceCandidate>(input: {
  workspaces: Iterable<Workspace>;
  agents: Iterable<QuickAskAgentActivity>;
}): Workspace[] {
  const agents = Array.from(input.agents);
  return Array.from(input.workspaces)
    .filter(
      (workspace) => !workspace.archivingAt && isHomeDirectoryPath(workspace.workspaceDirectory),
    )
    .map((workspace) => ({ workspace, activity: lastActivityOf(workspace, agents) }))
    .sort(
      (left, right) =>
        right.activity - left.activity || left.workspace.id.localeCompare(right.workspace.id),
    )
    .map(({ workspace }) => workspace);
}

/**
 * Where the new quick-ask agent opens: the workspace set for the host when it still exists,
 * otherwise the most recently active home-folder workspace, otherwise a new one.
 */
export function resolveQuickAskWorkspace(input: {
  configuredWorkspaceId: string | null;
  workspaces: Iterable<QuickAskWorkspaceCandidate>;
  agents: Iterable<QuickAskAgentActivity>;
}): QuickAskWorkspaceTarget {
  const workspaces = Array.from(input.workspaces);
  const configured = input.configuredWorkspaceId
    ? workspaces.find(
        (workspace) => workspace.id === input.configuredWorkspaceId && !workspace.archivingAt,
      )
    : undefined;
  if (configured) {
    return { kind: "workspace", workspaceId: configured.id, source: "setting" };
  }
  const home = listHomeWorkspaces({ workspaces, agents: input.agents })[0];
  if (home) {
    return { kind: "workspace", workspaceId: home.id, source: "home" };
  }
  return { kind: "create" };
}
