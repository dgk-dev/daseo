import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  buildProviderSelectionPolicyMap,
  startsNewSessionsFromDefaults,
} from "./provider-selection-policy";

describe("provider selection policy", () => {
  it("derives new-session preference behavior from provider snapshot data", () => {
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "custom-provider",
        status: "ready",
        enabled: true,
        selectionPolicy: {
          preferenceMode: "defaults",
          defaultModelId: "model-a",
        },
      },
    ];

    const policy = buildProviderSelectionPolicyMap(entries).get("custom-provider");
    expect(startsNewSessionsFromDefaults(policy)).toBe(true);
    expect(policy?.defaultModelId).toBe("model-a");
  });

  it("keeps providers sticky when no explicit policy is advertised", () => {
    expect(startsNewSessionsFromDefaults(undefined)).toBe(false);
  });
});
