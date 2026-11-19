import React, { useEffect } from "react";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { sidebarOrderSync } from "@/stores/sidebar-order-sync";

/**
 * Daseo delta 133: attaches every connected host that keeps the shared sidebar order. A host
 * without `sidebarOrderSync` is left alone and the sidebar keeps its local order, as before.
 */
export function SidebarOrderSyncSubscriber() {
  const hosts = useHosts();
  return (
    <>
      {hosts.map((host) => (
        <SidebarOrderHostSync key={host.serverId} serverId={host.serverId} />
      ))}
    </>
  );
}

function SidebarOrderHostSync({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "sidebarOrderSync");

  useEffect(() => {
    if (!client || !isConnected || !supported) return;
    void sidebarOrderSync.attach(serverId, client);
    return () => sidebarOrderSync.detach(serverId);
  }, [client, isConnected, serverId, supported]);

  return null;
}
