import { describe, expect, it } from "vitest";

import { mergeProviderPreferences } from "./use-form-preferences";

describe("mergeProviderPreferences", () => {
  it("stores the selected model for a provider", () => {
    expect(
      mergeProviderPreferences({
        preferences: {},
        provider: "claude",
        updates: { model: "claude-opus-4-6" },
      }),
    ).toEqual({
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-opus-4-6",
        },
      },
    });
  });

  it("merges thinking preferences by model without dropping existing entries", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "claude",
          providerPreferences: {
            claude: {
              model: "claude-sonnet-4-6",
              thinkingByModel: {
                "claude-sonnet-4-6": "medium",
              },
            },
          },
        },
        provider: "claude",
        updates: {
          thinkingByModel: {
            "claude-opus-4-6": "high",
          },
        },
      }),
    ).toEqual({
      provider: "claude",
      providerPreferences: {
        claude: {
          model: "claude-sonnet-4-6",
          thinkingByModel: {
            "claude-sonnet-4-6": "medium",
            "claude-opus-4-6": "high",
          },
        },
      },
    });
  });

  it("merges model-scoped feature values without leaking across models", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "pi",
          providerPreferences: {
            pi: {
              model: "sol",
              featureValuesByModel: {
                sol: { fast_mode: true },
                fable: {},
              },
            },
          },
        },
        provider: "pi",
        updates: {
          featureValuesByModel: {
            sol: { plan_mode: true },
          },
        },
      }),
    ).toMatchObject({
      providerPreferences: {
        pi: {
          featureValuesByModel: {
            sol: { fast_mode: true, plan_mode: true },
            fable: {},
          },
        },
      },
    });
  });

  it("keeps legacy flat feature values readable during migration", () => {
    expect(
      mergeProviderPreferences({
        preferences: {
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-5.4",
              featureValues: {
                fast_mode: true,
              },
            },
          },
        },
        provider: "codex",
        updates: {
          featureValues: {
            plan_mode: true,
          },
        },
      }),
    ).toEqual({
      provider: "codex",
      providerPreferences: {
        codex: {
          model: "gpt-5.4",
          featureValues: {
            fast_mode: true,
            plan_mode: true,
          },
        },
      },
    });
  });
});
