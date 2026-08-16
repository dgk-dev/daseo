import type { Href } from "expo-router";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildHostEmptyRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import { resolveWorkspaceRouteId } from "@/utils/workspace-identity";

function selectArchiveSibling(
  archivedWorkspace: WorkspaceDescriptor,
  workspaces: readonly WorkspaceDescriptor[],
): WorkspaceDescriptor | null {
  const siblings = workspaces.filter(
    (workspace) =>
      workspace.id !== archivedWorkspace.id &&
      workspace.projectId === archivedWorkspace.projectId &&
      workspace.archivingAt === null,
  );
  return (
    siblings.find((workspace) => workspace.workspaceKind === "local_checkout") ??
    siblings.find((workspace) => workspace.workspaceKind === "checkout") ??
    siblings[0] ??
    null
  );
}

export function buildWorkspaceArchiveRedirectRoute(input: {
  serverId: string;
  archivedWorkspaceId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
}): Href {
  const archivedWorkspaceId = resolveWorkspaceRouteId({
    routeWorkspaceId: input.archivedWorkspaceId,
  });
  const workspaces = Array.from(input.workspaces);
  const archivedWorkspace = archivedWorkspaceId
    ? (workspaces.find((workspace) => workspace.id === archivedWorkspaceId) ?? null)
    : null;
  if (!archivedWorkspace) {
    return buildHostEmptyRoute(input.serverId);
  }

  const sibling = selectArchiveSibling(archivedWorkspace, workspaces);
  if (!sibling) {
    return buildHostEmptyRoute(input.serverId);
  }

  return buildHostWorkspaceRoute(input.serverId, sibling.id);
}
