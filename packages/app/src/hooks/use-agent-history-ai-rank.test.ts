import { beforeAll, describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

(globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;

type AiRankModule = typeof import("./use-agent-history-ai-rank");
let applyAiOrder: AiRankModule["applyAiOrder"];
let mergeHostRankings: AiRankModule["mergeHostRankings"];

beforeAll(async () => {
  const module = await import("./use-agent-history-ai-rank");
  applyAiOrder = module.applyAiOrder;
  mergeHostRankings = module.mergeHostRankings;
});

describe("mergeHostRankings", () => {
  it("lets each host reorder only the slots its rows held", () => {
    const top = ["a:1", "b:1", "a:2", "a:3", "b:2"];
    const merged = mergeHostRankings(
      top,
      (key) => key.split(":")[0] ?? "",
      new Map([
        ["a", ["a:3", "a:1", "a:2"]],
        ["b", ["b:2", "b:1"]],
      ]),
    );
    expect(merged).toEqual(["a:3", "b:2", "a:1", "a:2", "b:1"]);
  });
});

describe("applyAiOrder", () => {
  it("puts the ranked rows first and keeps every other row after them in place", () => {
    const agent = (serverId: string, id: string) => ({ serverId, id }) as AggregatedAgent;
    const agents = [agent("s", "1"), agent("s", "2"), agent("s", "3"), agent("s", "4")];
    expect(applyAiOrder(agents, ["s:3", "s:1", "s:2"]).map((row) => row.id)).toEqual([
      "3",
      "1",
      "2",
      "4",
    ]);
  });
});
