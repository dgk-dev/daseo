import React, { useEffect } from "react";
import { AppState } from "react-native";
import { composerDraftSync } from "@/composer/draft-sync/composer-draft-sync";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";

/**
 * Daseo delta 139: attaches every connected host that keeps synced composer drafts, and
 * reconciles again when the app comes back to the foreground. A host without
 * `composerDraftSync` is left alone and its chats keep device-local drafts, as before.
 */
export function ComposerDraftSyncSubscriber() {
  const hosts = useHosts();
  return (
    <>
      {hosts.map((host) => (
        <ComposerDraftHostSync key={host.serverId} serverId={host.serverId} />
      ))}
    </>
  );
}

function ComposerDraftHostSync({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "composerDraftSync");

  useEffect(() => {
    if (!client || !isConnected || !supported) return;
    void composerDraftSync.attach(serverId, client);
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void composerDraftSync.attach(serverId, client);
    });
    return () => {
      foreground.remove();
      composerDraftSync.detach(serverId);
    };
  }, [client, isConnected, serverId, supported]);

  return null;
}
