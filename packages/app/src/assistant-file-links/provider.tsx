import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import React from "react";
import type { ToastApi } from "@/components/toast-host";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import type { OpenFileDisposition } from "@/workspace/file-open";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkContext, GetDirectorySuggestions, ResolvePath } from "./resolver";

export interface AssistantFileLinkDaemonClient {
  getDirectorySuggestions: GetDirectorySuggestions;
  resolvePath?: ResolvePath;
}

export interface AssistantFileLinkResolverConfig {
  client?: AssistantFileLinkDaemonClient | null;
  serverId?: string;
  /** The transcript's daemon runs on this machine, so its paths exist here (delta 56). */
  isLocalDaemon?: boolean;
  workspaceRoot?: string;
  /** Delta 90: the daemon resolves link paths (`server_info.features.pathResolve`). */
  supportsPathResolve?: boolean;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  /**
   * Delta 62: on the phone, download the file and open it in another app. Resolves false when
   * the path is not a downloadable file (a folder, a missing path), so the file pane takes it.
   */
  openFileExternally?: (target: InlinePathTarget) => Promise<boolean>;
  toast?: ToastApi | null;
}

export interface AssistantFileLinkResolverProviderProps extends AssistantFileLinkResolverConfig {
  children: ReactNode;
}

export interface AssistantFileLinkResolverContextValue {
  configRef: MutableRefObject<AssistantFileLinkResolverConfig>;
  getDirectorySuggestions: GetDirectorySuggestions;
  resolvePath: ResolvePath;
}

const AssistantFileLinkResolverContext =
  createContext<AssistantFileLinkResolverContextValue | null>(null);

export function AssistantFileLinkResolverProvider({
  client,
  serverId,
  workspaceRoot,
  supportsPathResolve,
  onOpenWorkspaceFile,
  openFileExternally,
  toast,
  children,
}: AssistantFileLinkResolverProviderProps) {
  const isLocalDaemon = useIsLocalDaemon(serverId ?? "");
  const configRef = useRef<AssistantFileLinkResolverConfig>({
    client,
    serverId,
    isLocalDaemon,
    workspaceRoot,
    supportsPathResolve,
    onOpenWorkspaceFile,
    openFileExternally,
    toast,
  });
  configRef.current = {
    client,
    serverId,
    isLocalDaemon,
    workspaceRoot,
    supportsPathResolve,
    onOpenWorkspaceFile,
    openFileExternally,
    toast,
  };

  const getDirectorySuggestions = useCallback<GetDirectorySuggestions>(async (input) => {
    const activeClient = configRef.current.client;
    if (!activeClient) {
      return { entries: [], error: null };
    }

    const result = await activeClient.getDirectorySuggestions(input);
    return { entries: result.entries, error: result.error };
  }, []);

  const resolvePath = useCallback<ResolvePath>(async (input) => {
    const activeClient = configRef.current.client;
    if (!activeClient?.resolvePath) {
      return { matches: [], complete: true, error: "Path resolve unavailable." };
    }
    return activeClient.resolvePath(input);
  }, []);

  const value = useMemo<AssistantFileLinkResolverContextValue>(
    () => ({ configRef, getDirectorySuggestions, resolvePath }),
    [getDirectorySuggestions, resolvePath],
  );

  return (
    <AssistantFileLinkResolverContext.Provider value={value}>
      {children}
    </AssistantFileLinkResolverContext.Provider>
  );
}

export function useAssistantFileLinkResolverContext(): AssistantFileLinkResolverContextValue {
  const context = useContext(AssistantFileLinkResolverContext);
  if (!context) {
    throw new Error("AssistantFileLinkResolverProvider is required for assistant file links.");
  }
  return context;
}

export type { AssistantFileLinkContext };
