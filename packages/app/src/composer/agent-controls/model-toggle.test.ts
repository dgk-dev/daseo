import { describe, expect, it } from "vitest";
import { resolveModelToggleTarget } from "./model-toggle";

const fable52 = { provider: "pi", modelId: "fable-5-2" };
const fable51 = { provider: "pi", modelId: "fable-5-1" };
const opus55 = { provider: "pi", modelId: "opus-5-5", isDefault: true };
const sonnet = { provider: "pi", modelId: "sonnet-5-5" };

function target(rows: Parameters<typeof resolveModelToggleTarget>[0]["rows"], current: string) {
  return resolveModelToggleTarget({ rows, currentProvider: "pi", currentModelId: current })
    ?.modelId;
}

describe("resolveModelToggleTarget", () => {
  const roster = [fable52, fable51, opus55, sonnet];

  it("flips between the first row and the provider default", () => {
    expect(target(roster, "fable-5-2")).toBe("opus-5-5");
    expect(target(roster, "opus-5-5")).toBe("fable-5-2");
  });

  it("falls back to the second row when the default is the first row", () => {
    const rows = [{ ...fable52, isDefault: true }, fable51, sonnet];
    expect(target(rows, "fable-5-2")).toBe("fable-5-1");
    expect(target(rows, "fable-5-1")).toBe("fable-5-2");
  });

  it("falls back to the second row when no model is marked default", () => {
    expect(target([fable52, fable51, sonnet], "fable-5-2")).toBe("fable-5-1");
  });

  it("goes to the first row from any third model", () => {
    expect(target(roster, "sonnet-5-5")).toBe("fable-5-2");
    expect(target(roster, "fable-5-1")).toBe("fable-5-2");
  });

  it("only takes the default of the first row's provider", () => {
    const rows = [fable52, fable51, { provider: "codex", modelId: "gpt", isDefault: true }];
    expect(target(rows, "fable-5-2")).toBe("fable-5-1");
  });

  it("does nothing with one model or none", () => {
    expect(target([fable52], "fable-5-2")).toBeUndefined();
    expect(target([], "fable-5-2")).toBeUndefined();
  });
});
