/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePacedStreamText } from "./use-paced-stream-text";

vi.mock("react-native-reanimated", () => ({ useReducedMotion: () => false }));

// A 120 Hz display, driven by hand: one frame every 8.33 ms, the cadence of the Fold 7.
const FRAME_MS = 1000 / 120;
let pendingFrames: Map<number, () => void>;
let nextFrameId = 1;
let clockMs = 0;

function runFrames(count: number): void {
  for (let index = 0; index < count; index += 1) {
    clockMs += FRAME_MS;
    const frames = Array.from(pendingFrames.values());
    pendingFrames.clear();
    act(() => {
      for (const frame of frames) frame();
    });
  }
}

beforeEach(() => {
  pendingFrames = new Map();
  clockMs = 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => Math.floor(clockMs));
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    const id = nextFrameId++;
    pendingFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => pendingFrames.delete(id));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Six short lines: a shallow, fresh queue that stays in the smooth gear.
const LINES = Array.from({ length: 6 }, (_, index) => `line ${index}\n`);

describe("usePacedStreamText at 120 Hz", () => {
  it("reveals one line per display frame while committing about 30 times a second", () => {
    let renders = 0;
    const { result, rerender } = renderHook(
      ({ text }) => {
        renders += 1;
        return usePacedStreamText(text, true);
      },
      { initialProps: { text: "" } },
    );

    rerender({ text: LINES.join("") });
    const rendersBefore = renders;

    runFrames(1);
    expect(result.current).toBe(LINES[0]);
    runFrames(3);
    expect(result.current).toBe(LINES[0]);
    runFrames(1);
    // Five frames, five lines: the same reading speed as one line per frame.
    expect(result.current).toBe(LINES.slice(0, 5).join(""));
    runFrames(4);
    expect(result.current).toBe(LINES.join(""));

    // Nine frames (75 ms) took three commits instead of six.
    expect(renders - rendersBefore).toBe(3);
  });

  it("shows text that arrives after the reveal caught up on its next frame", () => {
    const { result, rerender } = renderHook(({ text }) => usePacedStreamText(text, true), {
      initialProps: { text: "" },
    });
    rerender({ text: LINES[0] });
    runFrames(1);
    expect(result.current).toBe(LINES[0]);

    rerender({ text: LINES[0] + LINES[1] });
    runFrames(1);
    expect(result.current).toBe(LINES[0] + LINES[1]);
  });
});
