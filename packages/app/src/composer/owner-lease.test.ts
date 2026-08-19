import { describe, expect, it } from "vitest";
import {
  claimComposerOwnerLease,
  createComposerOwnerLeaseToken,
  ownsComposerOwnerLease,
  releaseComposerOwnerLease,
} from "./owner-lease";

const SCOPE_ID = "server:workspace";

describe("composer owner lease", () => {
  it("invalidates a retained composer's stale token when another agent becomes active", () => {
    const first = createComposerOwnerLeaseToken();
    const second = createComposerOwnerLeaseToken();
    claimComposerOwnerLease({ scopeId: SCOPE_ID, agentId: "agent-a", token: first });
    expect(ownsComposerOwnerLease({ scopeId: SCOPE_ID, agentId: "agent-a", token: first })).toBe(
      true,
    );

    claimComposerOwnerLease({ scopeId: SCOPE_ID, agentId: "agent-b", token: second });
    expect(ownsComposerOwnerLease({ scopeId: SCOPE_ID, agentId: "agent-a", token: first })).toBe(
      false,
    );
    expect(ownsComposerOwnerLease({ scopeId: SCOPE_ID, agentId: "agent-b", token: second })).toBe(
      true,
    );

    releaseComposerOwnerLease({ scopeId: SCOPE_ID, token: first });
    expect(ownsComposerOwnerLease({ scopeId: SCOPE_ID, agentId: "agent-b", token: second })).toBe(
      true,
    );
  });

  it("keeps independent workspace scopes from revoking each other", () => {
    const first = createComposerOwnerLeaseToken();
    const second = createComposerOwnerLeaseToken();
    claimComposerOwnerLease({ scopeId: "server:workspace-a", agentId: "agent-a", token: first });
    claimComposerOwnerLease({ scopeId: "server:workspace-b", agentId: "agent-b", token: second });

    expect(
      ownsComposerOwnerLease({
        scopeId: "server:workspace-a",
        agentId: "agent-a",
        token: first,
      }),
    ).toBe(true);
    expect(
      ownsComposerOwnerLease({
        scopeId: "server:workspace-b",
        agentId: "agent-b",
        token: second,
      }),
    ).toBe(true);
  });
});
