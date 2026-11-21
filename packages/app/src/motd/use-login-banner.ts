import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { LoginBannerFacts } from "./format";

/**
 * Host facts for the login banner, read from the daemon each time an empty chat appears. A host
 * without `loginBanner` (an older daemon) or a failed read gives null, and the banner shows only
 * what the app itself knows.
 */
export function useLoginBannerFacts(serverId: string | null | undefined): LoginBannerFacts | null {
  const normalizedServerId = serverId?.trim() ?? "";
  const supported = useHostFeature(normalizedServerId, "loginBanner");
  const client = useHostRuntimeClient(normalizedServerId);
  // Read again on every mount: the banner shows the host as it is when the empty chat appears.
  const query = useFetchQuery({
    queryKey: ["login-banner", normalizedServerId],
    queryFn: async (): Promise<LoginBannerFacts> => {
      if (!client) throw new Error("Host is not connected");
      const { requestId: _requestId, ...facts } = await client.getLoginBanner();
      return facts;
    },
    enabled: supported && client !== null,
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return query.data ?? null;
}
