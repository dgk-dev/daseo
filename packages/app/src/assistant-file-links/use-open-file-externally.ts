import { useCallback, useMemo } from "react";
import { isNative } from "@/constants/platform";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDownloadStore } from "@/stores/download-store";
import type { InlinePathTarget } from "./parse";

function splitPath(path: string): { directory: string; name: string } | null {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null;
  }
  return { directory: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
}

/**
 * Daseo delta 62: on the phone a path the agent names is downloaded from the daemon and
 * opened in another app, instead of in a Daseo file pane. The daemon scopes a download to
 * one directory, so the file's own directory is the scope; that covers paths outside the
 * workspace too (a report under ~/Downloads, say). A folder or a missing path answers false.
 */
export function useOpenFileExternally(input: {
  serverId: string;
}): ((target: InlinePathTarget) => Promise<boolean>) | undefined {
  const client = useHostRuntimeClient(input.serverId);
  const hosts = useHosts();
  const daemonProfile = useMemo(
    () => hosts.find((host) => host.serverId === input.serverId),
    [hosts, input.serverId],
  );
  const startDownload = useDownloadStore((state) => state.startDownload);

  const open = useCallback(
    async (target: InlinePathTarget): Promise<boolean> => {
      if (!client) {
        return false;
      }
      const split = splitPath(target.path);
      if (!split) {
        return false;
      }
      let token: Awaited<ReturnType<typeof client.requestDownloadToken>>;
      try {
        token = await client.requestDownloadToken(split.directory, split.name);
      } catch {
        return false;
      }
      if (token.error || !token.token) {
        return false;
      }
      void startDownload({
        serverId: input.serverId,
        scopeId: split.directory,
        fileName: token.fileName ?? split.name,
        path: split.name,
        daemonProfile,
        requestFileDownloadToken: async () => token,
      });
      return true;
    },
    [client, daemonProfile, input.serverId, startDownload],
  );

  return isNative ? open : undefined;
}
