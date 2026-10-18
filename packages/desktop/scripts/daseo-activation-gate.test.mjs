import { describe, expect, test } from "vitest";
import { classifyAgents, waitForSafeMoment } from "./daseo-activation-gate.mjs";

function scripted(snapshots) {
  let index = 0;
  const lines = [];
  let clock = 0;
  return {
    lines,
    calls: () => index,
    options: {
      snapshot: async () => snapshots[Math.min(index++, snapshots.length - 1)],
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      log: (line) => lines.push(line),
      pollMs: 15_000,
      settleMs: 20_000,
      maxWaitMs: 90 * 60_000,
    },
  };
}

const idle = { shortId: "a1", status: "idle", backgroundWaits: 0 };
const running = { shortId: "a1", status: "running", backgroundWaits: 0 };
const waitingIdle = { shortId: "a1", status: "idle", backgroundWaits: 1 };

describe("Daseo activation gate", () => {
  test("classifies running agents and idle agents that hold background waits", () => {
    expect(classifyAgents([running, waitingIdle, idle])).toEqual({
      busy: ["a1"],
      waiting: ["a1(1)"],
    });
  });

  test("an agent that goes idle and then registers a wait blocks the replacement", async () => {
    // Given: the agent finishes its turn, then registers a wait inside the settle window.
    const gate = scripted([[running], [idle], [waitingIdle], [waitingIdle], [idle], [idle]]);

    await waitForSafeMoment(gate.options);

    // Then: the gate only returns after two consecutive clean snapshots.
    expect(gate.calls()).toBe(6);
    expect(gate.lines.some((line) => line.includes("became active during the settle window"))).toBe(
      true,
    );
  });

  test("an unreadable agent list counts as busy", async () => {
    const gate = scripted([null, [idle], [idle]]);
    await waitForSafeMoment(gate.options);
    expect(gate.lines[0]).toContain("agent list unavailable");
  });

  test("background waits are honored only up to the cap; running agents always block", async () => {
    const gate = scripted([[waitingIdle]]);
    gate.options.maxWaitMs = 60_000;
    const result = await waitForSafeMoment(gate.options);
    expect(result.waiting).toEqual(["a1(1)"]);
    expect(gate.lines.some((line) => line.includes("restart recovery will notify"))).toBe(true);
  });

  test("the final check before quitting skips the settle window", async () => {
    const gate = scripted([[idle]]);
    gate.options.settleMs = 0;
    await waitForSafeMoment(gate.options);
    expect(gate.calls()).toBe(1);
  });
});
