import { useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { resolveShellPrompt, type ShellPromptParts } from "./shell-prompt";

/** The prompt for one host and working directory (see `shell-prompt.ts`). */
export function useShellPromptParts(
  serverId: string | null | undefined,
  cwd: string | null | undefined,
): ShellPromptParts {
  const hostname = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.serverInfo?.hostname ?? null) : null,
  );
  const hosts = useHosts();
  const hostLabel = useMemo(
    () => (serverId ? (hosts.find((host) => host.serverId === serverId)?.label ?? null) : null),
    [hosts, serverId],
  );
  return useMemo(
    () => resolveShellPrompt({ cwd, hostname, hostLabel }),
    [cwd, hostname, hostLabel],
  );
}
