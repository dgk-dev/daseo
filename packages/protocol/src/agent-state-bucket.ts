import type { AgentLifecycleStatus } from "./agent-lifecycle.js";
import type { WorkspaceStateBucket } from "./messages.js";

export type { WorkspaceStateBucket };
export type AgentAttentionReason = "finished" | "error" | "permission" | null | undefined;

export interface AgentStateBucketInput {
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentAttentionReason;
  backgroundWaits?: { pending: number } | null;
}

const WORKSPACE_STATE_BUCKET_PRIORITY = {
  needs_input: 0,
  failed: 1,
  running: 2,
  attention: 3,
  done: 4,
} as const satisfies Record<WorkspaceStateBucket, number>;

/**
 * Daseo: an idle agent that ended its turn with background waits pending (pi-local
 * `wait_for`) will be woken by them, so it presents as busy. Lifecycle stays `idle`
 * (composer and queue semantics key off it); only the bucket and sort priority change.
 * Permission, error, and unread attention keep their own buckets.
 */
export function isAgentWaitingInBackground(input: AgentStateBucketInput): boolean {
  return (
    input.status === "idle" &&
    (input.backgroundWaits?.pending ?? 0) > 0 &&
    (input.pendingPermissionCount ?? 0) === 0 &&
    input.attentionReason !== "permission" &&
    input.attentionReason !== "error" &&
    !input.requiresAttention
  );
}

export function deriveAgentStateBucket(input: AgentStateBucketInput): WorkspaceStateBucket {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return "needs_input";
  }
  if (input.status === "error" || input.attentionReason === "error") {
    return "failed";
  }
  if (input.status === "running" || isAgentWaitingInBackground(input)) {
    return "running";
  }
  if (input.requiresAttention) {
    return "attention";
  }
  return "done";
}

export function getWorkspaceStateBucketPriority(bucket: WorkspaceStateBucket): number {
  return WORKSPACE_STATE_BUCKET_PRIORITY[bucket];
}

export function getAgentStatusPriority(input: AgentStateBucketInput): number {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return 0;
  }
  if (input.status === "error" || input.attentionReason === "error") {
    return 1;
  }
  if (input.status === "running" || isAgentWaitingInBackground(input)) {
    return 2;
  }
  if (input.status === "initializing") {
    return 3;
  }
  return 4;
}
