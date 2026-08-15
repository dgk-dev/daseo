import { useEffect, useRef, useState } from "react";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { HostProjectListItem } from "@/projects/host-projects";
import type { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { runCreateEmptyWorkspace } from "./new-workspace-empty";

export interface AutoCreateEmptyWorkspaceInput {
  /** Route carried an explicit project context (sidebar project launches). */
  requested: boolean;
  isConnected: boolean;
  selectedProject: HostProjectListItem | null;
  selectedSourceDirectory: string | null;
  selectedServerId: string;
  supportsWorkspaceMultiplicity: boolean;
  effectiveIsolation: "local" | "worktree";
  createdWorkspace: ReturnType<typeof normalizeWorkspaceDescriptor> | null;
  ensureWorkspace: (input: {
    cwd: string;
    prompt: string;
    attachments: AgentAttachment[];
    withInitialAgent: boolean;
  }) => Promise<ReturnType<typeof normalizeWorkspaceDescriptor>>;
  setPendingAction: (action: "empty" | null) => void;
  onError: (message: string | null) => void;
  fallbackErrorMessage: string;
}

/**
 * Project-scoped launches skip the intro form: create an empty local workspace
 * immediately and land in the normal workspace screen, where browser and
 * terminal tabs can be opened before any agent runs. Returns whether the
 * intro should stay hidden while this runs; falls back to the intro form for
 * non-local isolation preferences, old daemons, and creation failures.
 */
export function useAutoCreateEmptyWorkspace(input: AutoCreateEmptyWorkspaceInput): boolean {
  const [failed, setFailed] = useState(false);
  const startedRef = useRef(false);
  const active = input.requested && !failed && !input.createdWorkspace;

  const {
    requested,
    isConnected,
    selectedProject,
    selectedSourceDirectory,
    selectedServerId,
    supportsWorkspaceMultiplicity,
    effectiveIsolation,
    createdWorkspace,
    ensureWorkspace,
    setPendingAction,
    onError,
    fallbackErrorMessage,
  } = input;

  useEffect(() => {
    if (!requested || failed || startedRef.current) {
      return;
    }
    if (createdWorkspace || !isConnected || !selectedProject || !selectedSourceDirectory) {
      return;
    }
    if (!supportsWorkspaceMultiplicity || effectiveIsolation !== "local") {
      setFailed(true);
      return;
    }
    startedRef.current = true;
    setPendingAction("empty");
    runCreateEmptyWorkspace({
      payload: { text: "", cwd: selectedSourceDirectory, attachments: [] },
      ensureWorkspace,
      serverId: selectedServerId,
      navigate: (targetServerId, workspaceId) =>
        navigateToWorkspace({ serverId: targetServerId, workspaceId }),
    })
      .catch((error) => {
        setFailed(true);
        onError(error instanceof Error ? error.message : fallbackErrorMessage);
      })
      .finally(() => {
        setPendingAction(null);
      });
  }, [
    requested,
    failed,
    createdWorkspace,
    effectiveIsolation,
    ensureWorkspace,
    fallbackErrorMessage,
    isConnected,
    onError,
    selectedProject,
    selectedServerId,
    selectedSourceDirectory,
    setPendingAction,
    supportsWorkspaceMultiplicity,
  ]);

  return active;
}
