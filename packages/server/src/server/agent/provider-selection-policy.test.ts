import { describe, expect, test } from "vitest";
import type { AgentProviderSelectionPolicy } from "@getpaseo/protocol/agent-types";
import {
  applySelectionPolicyToModels,
  resolveSelectionPolicyFeatureDefaults,
  resolveSelectionPolicyThinkingDefault,
} from "./provider-selection-policy.js";

const policy: AgentProviderSelectionPolicy = {
  preferenceMode: "defaults",
  defaultModelId: "runtime/model-b",
  thinkingDefaultsByModel: {
    "runtime/model-a": "high",
    "runtime/model-b": "xhigh",
  },
};

const models = [
  {
    provider: "test",
    id: "runtime/model-a",
    label: "Model A",
    isDefault: true,
    thinkingOptions: [
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High" },
    ],
    defaultThinkingOptionId: "medium",
  },
  {
    provider: "test",
    id: "runtime/model-b",
    aliases: ["model-b"],
    label: "Model B",
    thinkingOptions: [
      { id: "high", label: "High", isDefault: true },
      { id: "xhigh", label: "XHigh" },
    ],
    defaultThinkingOptionId: "high",
  },
];

describe("provider selection policy", () => {
  test("decorates runtime capabilities without replacing their option set", () => {
    const decorated = applySelectionPolicyToModels(models, policy);

    expect(decorated[0]).toMatchObject({
      id: "runtime/model-a",
      isDefault: false,
      defaultThinkingOptionId: "high",
    });
    expect(decorated[1]).toMatchObject({
      id: "runtime/model-b",
      isDefault: true,
      defaultThinkingOptionId: "xhigh",
    });
    expect(decorated[1]?.thinkingOptions?.map((option) => [option.id, option.isDefault])).toEqual([
      ["high", false],
      ["xhigh", true],
    ]);
  });

  test("ignores a policy default the runtime does not support", () => {
    const decorated = applySelectionPolicyToModels(models, {
      ...policy,
      thinkingDefaultsByModel: { "runtime/model-a": "max" },
    });

    expect(decorated[0]?.defaultThinkingOptionId).toBe("medium");
  });

  test("resolves model-scoped feature defaults without crossing models", () => {
    const withFeatures: AgentProviderSelectionPolicy = {
      ...policy,
      featureDefaultsByModel: {
        "runtime/model-a": { fast_mode: false },
      },
    };

    expect(resolveSelectionPolicyFeatureDefaults(withFeatures, "runtime/model-a")).toEqual({
      fast_mode: false,
    });
    expect(resolveSelectionPolicyFeatureDefaults(withFeatures, "runtime/model-b")).toEqual({});
  });

  test("resolves qualified and unqualified model references", () => {
    expect(resolveSelectionPolicyThinkingDefault(policy, "runtime/model-b")).toBe("xhigh");
    expect(
      resolveSelectionPolicyThinkingDefault(
        { ...policy, thinkingDefaultsByModel: { "model-b": "high" } },
        "runtime/model-b",
      ),
    ).toBe("high");
  });
});
