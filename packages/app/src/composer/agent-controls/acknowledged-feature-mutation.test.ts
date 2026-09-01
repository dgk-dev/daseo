import { describe, expect, it, vi } from "vitest";
import { applyAcknowledgedFeatureMutation } from "./acknowledged-feature-mutation";

describe("applyAcknowledgedFeatureMutation", () => {
  it("persists only after the runtime acknowledges the feature value", async () => {
    const order: string[] = [];

    await applyAcknowledgedFeatureMutation({
      acceptRuntimeValue: async () => {
        order.push("accepted");
      },
      persistPreference: async () => {
        order.push("persisted");
      },
    });

    expect(order).toEqual(["accepted", "persisted"]);
  });

  it("does not persist a rejected runtime value", async () => {
    const persistPreference = vi.fn(async () => undefined);

    await expect(
      applyAcknowledgedFeatureMutation({
        acceptRuntimeValue: async () => {
          throw new Error("unsupported feature");
        },
        persistPreference,
      }),
    ).rejects.toThrow("unsupported feature");
    expect(persistPreference).not.toHaveBeenCalled();
  });
});
