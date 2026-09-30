import { describe, expect, it } from "vitest";
import {
  deriveAgentStateBucket,
  getAgentStatusPriority,
  getWorkspaceStateBucketPriority,
  isAgentWaitingInBackground,
} from "./agent-state-bucket.js";

describe("deriveAgentStateBucket", () => {
  it("prioritizes pending permissions as needs_input", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        pendingPermissionCount: 1,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe("needs_input");
  });

  it("keeps legacy permission attention in needs_input", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "permission",
      }),
    ).toBe("needs_input");
  });

  it("prioritizes error attention before running status", () => {
    expect(
      deriveAgentStateBucket({
        status: "running",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "error",
      }),
    ).toBe("failed");
  });

  it("treats unread finished agents as attention", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        pendingPermissionCount: 0,
        requiresAttention: true,
        attentionReason: "finished",
      }),
    ).toBe("attention");
  });

  it("does not count initializing agents as running for workspace buckets", () => {
    expect(
      deriveAgentStateBucket({
        status: "initializing",
        pendingPermissionCount: 0,
        requiresAttention: false,
        attentionReason: null,
      }),
    ).toBe("done");
  });

  it("presents an idle agent with pending background waits as running", () => {
    const input = {
      status: "idle" as const,
      pendingPermissionCount: 0,
      requiresAttention: false,
      attentionReason: null,
      backgroundWaits: { pending: 2 },
    };
    expect(isAgentWaitingInBackground(input)).toBe(true);
    expect(deriveAgentStateBucket(input)).toBe("running");
  });

  it("keeps permission requests ahead of pending background waits", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        pendingPermissionCount: 1,
        requiresAttention: false,
        attentionReason: null,
        backgroundWaits: { pending: 1 },
      }),
    ).toBe("needs_input");
  });

  it("keeps unread attention and errors ahead of pending background waits", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        requiresAttention: true,
        attentionReason: "finished",
        backgroundWaits: { pending: 1 },
      }),
    ).toBe("attention");
    expect(
      deriveAgentStateBucket({
        status: "error",
        requiresAttention: true,
        attentionReason: "error",
        backgroundWaits: { pending: 1 },
      }),
    ).toBe("failed");
  });

  it("treats an idle agent with no pending background waits as before", () => {
    expect(
      deriveAgentStateBucket({
        status: "idle",
        requiresAttention: false,
        attentionReason: null,
        backgroundWaits: { pending: 0 },
      }),
    ).toBe("done");
    expect(
      deriveAgentStateBucket({
        status: "idle",
        requiresAttention: true,
        attentionReason: "finished",
        backgroundWaits: { pending: 0 },
      }),
    ).toBe("attention");
  });
});

describe("getWorkspaceStateBucketPriority", () => {
  it("orders active buckets before done", () => {
    expect(
      ["done", "attention", "running", "failed", "needs_input"].sort(
        (left, right) =>
          getWorkspaceStateBucketPriority(left) - getWorkspaceStateBucketPriority(right),
      ),
    ).toEqual(["needs_input", "failed", "running", "attention", "done"]);
  });
});

describe("getAgentStatusPriority", () => {
  it("keeps initializing agents ahead of completed agents in agent lists", () => {
    expect(getAgentStatusPriority({ status: "initializing" })).toBeLessThan(
      getAgentStatusPriority({ status: "idle" }),
    );
  });

  it("sorts an idle agent with pending background waits with running agents", () => {
    expect(getAgentStatusPriority({ status: "idle", backgroundWaits: { pending: 1 } })).toBe(
      getAgentStatusPriority({ status: "running" }),
    );
    expect(getAgentStatusPriority({ status: "idle", backgroundWaits: { pending: 0 } })).toBe(
      getAgentStatusPriority({ status: "idle" }),
    );
    expect(
      getAgentStatusPriority({
        status: "idle",
        pendingPermissionCount: 1,
        backgroundWaits: { pending: 1 },
      }),
    ).toBe(0);
  });

  it("prioritizes pending permissions before errors and running agents", () => {
    const permission = getAgentStatusPriority({ status: "running", pendingPermissionCount: 1 });
    expect(permission).toBeLessThan(
      getAgentStatusPriority({ status: "error", pendingPermissionCount: 0 }),
    );
    expect(permission).toBeLessThan(
      getAgentStatusPriority({ status: "running", pendingPermissionCount: 0 }),
    );
  });
});
