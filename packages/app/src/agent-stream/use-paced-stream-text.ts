import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";
import {
  AdaptiveChunkingPolicy,
  advanceLineUnits,
  countLineUnits,
  lineUnitsForCommit,
  shouldCommitPacedFrame,
} from "./stream-pacing";

/**
 * Daseo delta 51: reveals a streaming reply at the Codex pace (see stream-pacing.ts):
 * one line unit per frame, the whole backlog when it runs 8 units deep or 120 ms old.
 * Daseo delta 87: the frames still set the pace, but the shown text is committed to React
 * only about 30 times a second, each commit catching up the units of the frames in between.
 * A reply that is not streaming, a reply mounted mid-stream, and reduce motion show the
 * text whole at once; the pace applies only to text that arrives while it is on screen.
 */
export function usePacedStreamText(text: string, streaming: boolean): string {
  const reduceMotion = useReducedMotion();
  const pacing = streaming && !reduceMotion;
  const [shownLength, setShownLength] = useState(text.length);
  const shownLengthRef = useRef(text.length);
  const textRef = useRef(text);
  const policyRef = useRef<AdaptiveChunkingPolicy | null>(null);
  // When each not-yet-shown stretch of text arrived: [end index, time]. The oldest entry
  // past the shown length is the age of the oldest queued line.
  const arrivalsRef = useRef<Array<[number, number]>>([]);
  const frameRef = useRef<number | null>(null);
  const framesSinceCommitRef = useRef(0);
  const lastCommitAtRef = useRef<number | null>(null);

  textRef.current = text;

  useEffect(() => {
    const cancelFrame = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const showAll = () => {
      cancelFrame();
      framesSinceCommitRef.current = 0;
      lastCommitAtRef.current = null;
      arrivalsRef.current = [];
      policyRef.current?.reset();
      shownLengthRef.current = text.length;
      setShownLength(text.length);
    };

    if (!pacing) {
      showAll();
      return;
    }
    // The text was replaced rather than extended (a rewind, a canonical reload).
    if (text.length < shownLengthRef.current) {
      showAll();
      return;
    }
    if (text.length === shownLengthRef.current) {
      return;
    }
    const arrivals = arrivalsRef.current;
    if ((arrivals.at(-1)?.[0] ?? shownLengthRef.current) < text.length) {
      arrivals.push([text.length, Date.now()]);
    }
    if (frameRef.current !== null) {
      return;
    }
    const policy = (policyRef.current ??= new AdaptiveChunkingPolicy());

    const tick = () => {
      frameRef.current = null;
      const now = Date.now();
      framesSinceCommitRef.current += 1;
      if (!shouldCommitPacedFrame(now, lastCommitAtRef.current)) {
        frameRef.current = requestAnimationFrame(tick);
        return;
      }
      const current = textRef.current;
      const from = shownLengthRef.current;
      const queuedLines = countLineUnits(current, from);
      const oldest = arrivalsRef.current[0];
      const oldestAgeMs = oldest ? now - oldest[1] : null;
      const lines = policy.decide({ queuedLines, oldestAgeMs }, now);
      const units = lineUnitsForCommit(lines, policy.getMode(), framesSinceCommitRef.current);
      const next = advanceLineUnits(current, from, units);
      framesSinceCommitRef.current = 0;
      lastCommitAtRef.current = now;
      shownLengthRef.current = next;
      setShownLength(next);
      // Drop arrivals the reveal has fully passed.
      while (arrivalsRef.current.length > 0 && arrivalsRef.current[0][0] <= next) {
        arrivalsRef.current.shift();
      }
      if (next < current.length) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        policy.decide({ queuedLines: 0, oldestAgeMs: null }, now);
        // Caught up: the next arrival is shown on its first frame, as before.
        lastCommitAtRef.current = null;
      }
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [pacing, text]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    },
    [],
  );

  return pacing && shownLength < text.length ? text.slice(0, shownLength) : text;
}
