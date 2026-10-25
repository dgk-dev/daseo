import { describe, expect, it } from "vitest";
import {
  QUICK_ASK_DICTATION_START_MS,
  QUICK_ASK_MAX_LISTEN_MS,
  QUICK_ASK_NO_SPEECH_MS,
  QUICK_ASK_SEND_COUNTDOWN_MS,
  QUICK_ASK_SILENCE_MS,
  QUICK_ASK_SPEECH_LEVEL,
  initialQuickAskVoicePhase,
  quickAskCountdownRemainingMs,
  stepQuickAskVoice,
  type QuickAskVoiceEffect,
  type QuickAskVoiceEvent,
  type QuickAskVoicePhase,
} from "./state";

function run(
  events: QuickAskVoiceEvent[],
  start: QuickAskVoicePhase = initialQuickAskVoicePhase(0),
) {
  let phase = start;
  const effects: QuickAskVoiceEffect[] = [];
  for (const event of events) {
    const step = stepQuickAskVoice(phase, event);
    phase = step.phase;
    effects.push(...step.effects);
  }
  return { phase, effects };
}

const tick = (now: number, dictationReady = true): QuickAskVoiceEvent => ({
  type: "tick",
  now,
  dictationReady,
});
const loud = (now: number): QuickAskVoiceEvent => ({
  type: "level",
  level: QUICK_ASK_SPEECH_LEVEL,
  now,
});

describe("quick-ask voice", () => {
  it("dictates, confirms after silence, counts down and sends once", () => {
    const listening = [tick(0), { type: "recordingStarted", now: 100 } as const];
    const spoken = [loud(400), loud(1200), { type: "level", level: 0.05, now: 1300 } as const];
    const beforeSilence = run([...listening, ...spoken, tick(1200 + QUICK_ASK_SILENCE_MS - 1)]);
    expect(beforeSilence.phase.kind).toBe("listening");
    expect(beforeSilence.effects).toEqual(["startDictation"]);

    const confirmed = run([...listening, ...spoken, tick(1200 + QUICK_ASK_SILENCE_MS)]);
    expect(confirmed.phase).toEqual({ kind: "transcribing" });
    expect(confirmed.effects).toEqual(["startDictation", "confirmDictation"]);

    const sent = run(
      [
        { type: "transcript", text: "오늘 일정 알려줘", now: 3000 },
        tick(3000 + QUICK_ASK_SEND_COUNTDOWN_MS - 1),
        tick(3000 + QUICK_ASK_SEND_COUNTDOWN_MS),
        tick(3000 + QUICK_ASK_SEND_COUNTDOWN_MS + 500),
      ],
      confirmed.phase,
    );
    expect(sent.phase).toEqual({ kind: "done", outcome: "sent" });
    expect(sent.effects).toEqual(["send"]);
  });

  it("shows the time left during the countdown and a tap cancels without sending", () => {
    const countdown = run([{ type: "transcript", text: "질문", now: 1000 }], {
      kind: "transcribing",
    }).phase;
    expect(quickAskCountdownRemainingMs(countdown, 1600)).toBe(QUICK_ASK_SEND_COUNTDOWN_MS - 600);
    const cancelled = run([{ type: "cancelCountdown" }, tick(10_000)], countdown);
    expect(cancelled.phase).toEqual({ kind: "done", outcome: "typing" });
    expect(cancelled.effects).toEqual([]);
    expect(quickAskCountdownRemainingMs(cancelled.phase, 10_000)).toBeNull();
  });

  it("gives up listening after the no-speech window and keeps the draft for typing", () => {
    const result = run([
      tick(0),
      { type: "recordingStarted", now: 0 },
      { type: "level", level: QUICK_ASK_SPEECH_LEVEL - 0.01, now: 5000 },
      tick(QUICK_ASK_NO_SPEECH_MS),
    ]);
    expect(result.phase).toEqual({ kind: "done", outcome: "typing" });
    expect(result.effects).toEqual(["startDictation", "cancelDictation"]);
  });

  it("confirms after the listening cap when steady noise never falls silent", () => {
    const listening: QuickAskVoicePhase = {
      kind: "listening",
      startedAt: 0,
      speechStartedAt: null,
      lastSpeechAt: null,
    };
    const noisy: QuickAskVoiceEvent[] = [];
    for (let now = 0; now < QUICK_ASK_MAX_LISTEN_MS; now += 500) {
      noisy.push(loud(now), tick(now));
    }
    const beforeCap = run(noisy, listening);
    expect(beforeCap.phase.kind).toBe("listening");
    expect(beforeCap.effects).toEqual([]);

    const atCap = run(
      [...noisy, loud(QUICK_ASK_MAX_LISTEN_MS), tick(QUICK_ASK_MAX_LISTEN_MS)],
      listening,
    );
    expect(atCap.phase).toEqual({ kind: "transcribing" });
    expect(atCap.effects).toEqual(["confirmDictation"]);
  });

  it("cancels to typing at the listening cap when no speech was ever detected", () => {
    const listening: QuickAskVoicePhase = {
      kind: "listening",
      startedAt: 0,
      speechStartedAt: null,
      lastSpeechAt: null,
    };
    const capped = stepQuickAskVoice(listening, tick(QUICK_ASK_MAX_LISTEN_MS));
    expect(capped.phase).toEqual({ kind: "done", outcome: "typing" });
    expect(capped.effects).toEqual(["cancelDictation"]);
  });

  it("falls back to typing when dictation never becomes ready or recording never starts", () => {
    expect(run([tick(0, false), tick(QUICK_ASK_DICTATION_START_MS, false)]).phase).toEqual({
      kind: "done",
      outcome: "typing",
    });
    const neverRecorded = run([tick(0), tick(QUICK_ASK_DICTATION_START_MS)]);
    expect(neverRecorded.phase).toEqual({ kind: "done", outcome: "typing" });
  });

  it("does not send an empty transcript or a recording the owner cancelled", () => {
    expect(
      run([{ type: "transcript", text: "  ", now: 1 }], { kind: "transcribing" }).phase,
    ).toEqual({ kind: "done", outcome: "typing" });
    expect(
      run([{ type: "recordingStopped", processing: false }], { kind: "transcribing" }).phase,
    ).toEqual({ kind: "done", outcome: "typing" });
    const listening: QuickAskVoicePhase = {
      kind: "listening",
      startedAt: 0,
      speechStartedAt: 10,
      lastSpeechAt: 10,
    };
    expect(run([{ type: "recordingStopped", processing: false }], listening).phase).toEqual({
      kind: "done",
      outcome: "typing",
    });
    // The overlay's own accept: still processing, the transcript then counts down as usual.
    const accepted = run(
      [
        { type: "recordingStopped", processing: true },
        { type: "transcript", text: "질문", now: 50 },
      ],
      listening,
    );
    expect(accepted.phase).toEqual({ kind: "countdown", sendAt: 50 + QUICK_ASK_SEND_COUNTDOWN_MS });
  });
});
