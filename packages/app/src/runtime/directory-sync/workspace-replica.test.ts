import { expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import {
  clearWorkspaceArchivePending,
  markWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { WorkspaceDirectoryReplica } from "./workspace-replica";

function workspace(id: string, projectId = "project"): WorkspaceDescriptorPayload {
  return {
    id,
    projectId,
    projectDisplayName: projectId,
    projectRootPath: `/repo/${projectId}`,
    workspaceDirectory: `/repo/${projectId}/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    title: id,
    status: "done",
    activityAt: null,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

it("commits workspace and project-parent state with filtered removals", () => {
  const serverId = "workspace-replica";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const empty = normalizeProjectDescriptor({
    projectId: "empty",
    projectDisplayName: "Empty",
    projectRootPath: "/repo/empty",
    projectKind: "git",
  });
  replica.commitSnapshot(
    {
      workspaces: new Map([
        ["kept", normalizeWorkspaceDescriptor(workspace("kept"))],
        ["filtered", normalizeWorkspaceDescriptor(workspace("filtered", "filtered-project"))],
      ]),
      projects: new Map([[empty.projectId, empty]]),
    },
    [{ kind: "remove", id: "filtered", removedProjectId: "filtered-project" }],
  );

  const session = useSessionStore.getState().sessions[serverId];
  expect(Array.from(session?.workspaces.keys() ?? [])).toEqual(["kept"]);
  expect(Array.from(session?.projects.keys() ?? [])).toEqual(["empty"]);
  store.clearSession(serverId);
});

it("commits the authoritative snapshot before buffered project updates", () => {
  const serverId = "project-update-replica";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const attachedMain = normalizeWorkspaceDescriptor(workspace("attached-main", "attached"));
  const attachedFeature = normalizeWorkspaceDescriptor(workspace("attached-feature", "attached"));
  const removed = normalizeWorkspaceDescriptor(workspace("removed", "removed"));
  const unrelated = normalizeWorkspaceDescriptor(workspace("unrelated", "unrelated"));
  const staleAttachedProject = normalizeProjectDescriptor({
    projectId: "attached",
    projectDisplayName: "Stale attached project",
    projectRootPath: "/repo/attached",
    projectKind: "git",
  });
  const removedProject = normalizeProjectDescriptor({
    projectId: "removed",
    projectDisplayName: "Removed project",
    projectRootPath: "/repo/removed",
    projectKind: "git",
  });
  const unchangedEmptyProject = normalizeProjectDescriptor({
    projectId: "unchanged-empty",
    projectDisplayName: "Unchanged empty project",
    projectRootPath: "/repo/unchanged-empty",
    projectKind: "git",
  });

  replica.commitSnapshot(
    {
      workspaces: new Map([
        [attachedMain.id, attachedMain],
        [attachedFeature.id, attachedFeature],
        [removed.id, removed],
        [unrelated.id, unrelated],
      ]),
      projects: new Map([
        [staleAttachedProject.projectId, staleAttachedProject],
        [removedProject.projectId, removedProject],
        [unchangedEmptyProject.projectId, unchangedEmptyProject],
      ]),
    },
    [
      {
        kind: "upsert",
        project: {
          projectId: "attached",
          projectKey: "remote:github.com/acme/attached",
          projectDisplayName: "Renamed attached project",
          projectCustomName: "Personal name",
          projectRootPath: "/moved/attached",
          projectKind: "directory",
        },
      },
      {
        kind: "upsert",
        project: {
          projectId: "new-empty",
          projectDisplayName: "New empty project",
          projectRootPath: "/repo/new-empty",
          projectKind: "directory",
        },
      },
      { kind: "remove", projectId: "removed" },
    ],
  );

  const session = useSessionStore.getState().sessions[serverId];
  expect(session?.workspaces.get(attachedMain.id)).toMatchObject({
    projectDisplayName: "Renamed attached project",
    projectCustomName: "Personal name",
    projectRootPath: "/moved/attached",
    projectKind: "directory",
  });
  expect(session?.workspaces.get(attachedFeature.id)).toMatchObject({
    projectDisplayName: "Renamed attached project",
    projectRootPath: "/moved/attached",
  });
  expect(session?.workspaces.has(removed.id)).toBe(false);
  expect(session?.workspaces.get(unrelated.id)).toBe(unrelated);
  expect(Array.from(session?.projects.keys() ?? [])).toEqual([
    "attached",
    "unchanged-empty",
    "new-empty",
  ]);
  expect(session?.projects.get("unchanged-empty")).toBe(unchangedEmptyProject);
  expect(session?.projects.get("new-empty")).toMatchObject({
    projectDisplayName: "New empty project",
    projectRootPath: "/repo/new-empty",
  });
  store.clearSession(serverId);
});

it("does not invent a null-key project from a workspace update", () => {
  const serverId = "workspace-before-project-update";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);

  replica.applyDelta({ kind: "upsert", workspace: workspace("main", "fresh-project") });

  const session = useSessionStore.getState().sessions[serverId];
  expect(session?.workspaces.has("main")).toBe(true);
  expect(session?.projects.has("fresh-project")).toBe(false);
  store.clearSession(serverId);
});

// Daseo delta 137: the desktop app discards the browser tabs of each workspace reported here.
it("reports an archived workspace once, and never an unarchived one", () => {
  const serverId = "archive-report-replica";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const onWorkspacesRemoved = vi.fn();
  const replica = new WorkspaceDirectoryReplica(serverId, { onWorkspacesRemoved });
  replica.commitSnapshot(
    {
      workspaces: new Map([
        ["kept", normalizeWorkspaceDescriptor(workspace("kept"))],
        ["archived", normalizeWorkspaceDescriptor(workspace("archived"))],
      ]),
      projects: new Map(),
    },
    [],
  );
  expect(onWorkspacesRemoved).not.toHaveBeenCalled();

  // Archived from another client: the daemon's remove update.
  replica.applyDelta({ kind: "remove", id: "archived" });
  expect(onWorkspacesRemoved).toHaveBeenCalledTimes(1);
  expect(onWorkspacesRemoved).toHaveBeenLastCalledWith(["archived"]);

  // A repeated remove and a later snapshot without it report nothing new.
  replica.applyDelta({ kind: "remove", id: "archived" });
  replica.commitSnapshot(
    {
      workspaces: new Map([["kept", normalizeWorkspaceDescriptor(workspace("kept"))]]),
      projects: new Map(),
    },
    [],
  );
  expect(onWorkspacesRemoved).toHaveBeenCalledTimes(1);

  // Unarchived: it comes back as an upsert, which reports nothing.
  replica.applyDelta({ kind: "upsert", workspace: workspace("archived") });
  replica.applyDelta({ kind: "upsert", workspace: workspace("kept") });
  expect(onWorkspacesRemoved).toHaveBeenCalledTimes(1);
  expect(useSessionStore.getState().sessions[serverId]?.workspaces.has("archived")).toBe(true);
  store.clearSession(serverId);
});

it("reports nothing for a workspace a snapshot merely no longer lists", () => {
  const serverId = "archive-snapshot-replica";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const onWorkspacesRemoved = vi.fn();
  const replica = new WorkspaceDirectoryReplica(serverId, { onWorkspacesRemoved });
  replica.applyDelta({ kind: "upsert", workspace: workspace("a") });
  replica.applyDelta({ kind: "upsert", workspace: workspace("b") });

  replica.commitSnapshot(
    {
      workspaces: new Map([["a", normalizeWorkspaceDescriptor(workspace("a"))]]),
      projects: new Map(),
    },
    [],
  );
  expect(onWorkspacesRemoved).not.toHaveBeenCalled();

  // A remove carried into a snapshot commit is reported.
  replica.applyDelta({ kind: "upsert", workspace: workspace("b") });
  replica.commitSnapshot(
    {
      workspaces: new Map([["a", normalizeWorkspaceDescriptor(workspace("a"))]]),
      projects: new Map(),
    },
    [{ kind: "remove", id: "b" }],
  );
  expect(onWorkspacesRemoved).toHaveBeenCalledTimes(1);
  expect(onWorkspacesRemoved).toHaveBeenLastCalledWith(["b"]);
  store.clearSession(serverId);
});

it("reports a local archive only once the daemon confirms it", () => {
  const serverId = "archive-local-replica";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const onWorkspacesRemoved = vi.fn();
  const replica = new WorkspaceDirectoryReplica(serverId, { onWorkspacesRemoved });
  replica.applyDelta({ kind: "upsert", workspace: workspace("local") });

  // The archive button hides the workspace before the daemon answers.
  markWorkspaceArchivePending({ serverId, workspaceId: "local" });
  store.removeWorkspace(serverId, "local");
  replica.applyDelta({ kind: "upsert", workspace: workspace("local") });
  expect(onWorkspacesRemoved).not.toHaveBeenCalled();

  replica.applyDelta({ kind: "remove", id: "local" });
  expect(onWorkspacesRemoved).toHaveBeenCalledTimes(1);
  expect(onWorkspacesRemoved).toHaveBeenLastCalledWith(["local"]);
  clearWorkspaceArchivePending({ serverId, workspaceId: "local" });
  store.clearSession(serverId);
});
