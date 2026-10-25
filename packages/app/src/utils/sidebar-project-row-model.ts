import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";

export interface SidebarProjectHostTarget {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
  iconRevision?: string;
}

export type SidebarProjectTrailingAction =
  | { kind: "new_workspace"; target: SidebarProjectHostTarget }
  | { kind: "none" };

export interface SidebarProjectSectionRowModel {
  kind: "project_section";
  chevron: "expand" | "collapse";
  trailingAction: SidebarProjectTrailingAction;
}

export type SidebarProjectRowModel = SidebarProjectSectionRowModel;

const EMPTY_MULTIPLICITY_MAP: ReadonlyMap<string, boolean | null> = new Map();
function hostTarget(input: {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
  iconRevision?: string;
}): SidebarProjectHostTarget | null {
  const iconWorkingDir = input.iconWorkingDir.trim();
  if (!input.serverId || !iconWorkingDir) {
    return null;
  }
  return {
    serverId: input.serverId,
    projectId: input.projectId,
    iconWorkingDir,
    customIconRevision: input.customIconRevision,
    iconRevision: input.iconRevision,
  };
}

export function resolveSidebarProjectIconTarget(
  project: SidebarProjectEntry,
): SidebarProjectHostTarget | null {
  for (const host of project.hosts) {
    const target = hostTarget(host);
    if (target) {
      return target;
    }
  }
  return null;
}

export interface SidebarProjectIconTarget extends SidebarProjectHostTarget {
  projectViewKey: string;
}

export function resolveSidebarProjectIconTargets(
  projects: readonly SidebarProjectEntry[],
): SidebarProjectIconTarget[] {
  return projects.flatMap((project) => {
    const target = resolveSidebarProjectIconTarget(project);
    return target ? [{ projectViewKey: project.viewKey, ...target }] : [];
  });
}

export function resolveSidebarProjectLocalPath(
  project: SidebarProjectEntry,
  localServerId: string | null,
): string {
  if (!localServerId) return "";
  return project.hosts.find((host) => host.serverId === localServerId)?.iconWorkingDir.trim() ?? "";
}

// A project can host a brand-new workspace on a host when that host can create a
// git worktree (git projects) OR the host supports running multiple independent
// workspaces per directory (`workspaceMultiplicity`), which is what lets non-git
// directories add a second workspace. Mirrors the gate used by the global "New
// workspace" affordances (use-global-new-workspace-action.ts and left-sidebar's
// SidebarNewWorkspaceHeaderRow): `canCreateWorktree || supportsMultiplicity`.
function resolveNewWorkspaceTarget(
  project: SidebarProjectEntry,
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean | null>,
): SidebarProjectHostTarget | null {
  for (const host of project.hosts) {
    // Daseo: `null` means the host's capabilities have not arrived yet (connecting or
    // reconnecting). The button stays, so a non-git project such as the home folder does not
    // lose it every time the phone reconnects; only a host known to lack the feature hides it.
    const supportsMultiplicity = supportsMultiplicityByServerId.get(host.serverId);
    if (
      host.worktreeSupport === "unsupported" &&
      supportsMultiplicity !== null &&
      !supportsMultiplicity
    ) {
      continue;
    }
    const target = hostTarget(host);
    if (target) return target;
  }
  return null;
}

function projectTrailingAction(
  project: SidebarProjectEntry,
  supportsMultiplicityByServerId: ReadonlyMap<string, boolean | null>,
): SidebarProjectTrailingAction {
  const target = resolveNewWorkspaceTarget(project, supportsMultiplicityByServerId);
  return target ? { kind: "new_workspace", target } : { kind: "none" };
}

export function buildSidebarProjectRowModel(input: {
  project: SidebarProjectEntry;
  collapsed: boolean;
  supportsMultiplicityByServerId?: ReadonlyMap<string, boolean | null>;
}): SidebarProjectRowModel {
  return {
    kind: "project_section",
    chevron: input.collapsed ? "expand" : "collapse",
    trailingAction: projectTrailingAction(
      input.project,
      input.supportsMultiplicityByServerId ?? EMPTY_MULTIPLICITY_MAP,
    ),
  };
}
