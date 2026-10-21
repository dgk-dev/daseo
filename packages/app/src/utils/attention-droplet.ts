import type { AgentAttentionNotificationPayload } from "@getpaseo/protocol/agent-attention-notification";
import type { SessionState } from "@/stores/session-store";
import { useAttentionDropletStore } from "@/stores/attention-droplet-store";

/**
 * The phone app suppresses OS banners while it is on screen, so an agent elsewhere that finishes
 * or asks for permission drops an in-app alert instead (the Ovis/herdr web UI droplet). Returns
 * whether it showed one; an error or a notification without a workspace shows nothing.
 */
export function showAttentionDroplet(input: {
  session: SessionState | undefined;
  serverId: string;
  agentId: string;
  reason: "finished" | "error" | "permission";
  notification: AgentAttentionNotificationPayload;
}): boolean {
  const { session, serverId, agentId, reason, notification } = input;
  const workspaceId = notification.data.workspaceId;
  if (!workspaceId || reason === "error") {
    return false;
  }
  const agent = session?.agents?.get(agentId);
  const workspace = session?.workspaces.get(workspaceId);
  useAttentionDropletStore.getState().show({
    serverId,
    workspaceId,
    agentId,
    reason,
    title:
      agent?.title?.trim() || workspace?.title?.trim() || workspace?.name || notification.title,
    detail: notification.body,
  });
  return true;
}
