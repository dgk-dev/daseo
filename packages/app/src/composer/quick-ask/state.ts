// Daseo delta 64: the voice half of quick ask. A quick-ask draft starts the composer's own
// dictation (the daemon's pipeline), confirms it once the speaker stops, and leaves the
// transcript in the composer with the keyboard up. It never sends: delta 70 made every
// dictation end in the composer, and the owner sends with the send button.

/** Dictation meter level that counts as speech: `((dBFS + 80) / 80)²`, so 0.25 ≈ −40 dBFS. */
export const QUICK_ASK_SPEECH_LEVEL = 0.25;
/** Silence after speech that ends the utterance and confirms dictation. */
export const QUICK_ASK_SILENCE_MS = 1500;
/** Listening with no speech this long gives up and leaves the keyboard for typing. */
export const QUICK_ASK_NO_SPEECH_MS = 8000;
/** How long to wait for the host to report dictation ready, and for recording to begin. */
export const QUICK_ASK_DICTATION_START_MS = 4000;
/**
 * Listening never runs longer than this from the start of recording. Steady noise above the speech
 * level (a street, a car) keeps moving `lastSpeechAt`, so silence alone would never end it.
 */
export const QUICK_ASK_MAX_LISTEN_MS = 30_000;

export type QuickAskVoicePhase =
  | { kind: "waitingForDictation"; since: number }
  | { kind: "starting"; since: number }
  | {
      kind: "listening";
      startedAt: number;
      speechStartedAt: number | null;
      lastSpeechAt: number | null;
    }
  | { kind: "transcribing" }
  | { kind: "done"; outcome: "typing" };

export type QuickAskVoiceEvent =
  | { type: "tick"; now: number; dictationReady: boolean }
  | { type: "recordingStarted"; now: number }
  | { type: "level"; level: number; now: number }
  /** Recording stopped; `processing` is true while the daemon is still transcribing. */
  | { type: "recordingStopped"; processing: boolean }
  | { type: "transcript"; text: string; now: number };

export type QuickAskVoiceEffect = "startDictation" | "confirmDictation" | "cancelDictation";

export interface QuickAskVoiceStep {
  phase: QuickAskVoicePhase;
  effects: QuickAskVoiceEffect[];
}

export function initialQuickAskVoicePhase(now: number): QuickAskVoicePhase {
  return { kind: "waitingForDictation", since: now };
}

const TYPING: QuickAskVoicePhase = { kind: "done", outcome: "typing" };

function stay(phase: QuickAskVoicePhase): QuickAskVoiceStep {
  return { phase, effects: [] };
}

function stepListening(
  phase: Extract<QuickAskVoicePhase, { kind: "listening" }>,
  event: QuickAskVoiceEvent,
): QuickAskVoiceStep {
  if (event.type === "level") {
    if (event.level < QUICK_ASK_SPEECH_LEVEL) {
      return stay(phase);
    }
    return stay({
      ...phase,
      speechStartedAt: phase.speechStartedAt ?? event.now,
      lastSpeechAt: event.now,
    });
  }
  if (event.type === "tick") {
    if (phase.lastSpeechAt !== null && event.now - phase.lastSpeechAt >= QUICK_ASK_SILENCE_MS) {
      return { phase: { kind: "transcribing" }, effects: ["confirmDictation"] };
    }
    if (event.now - phase.startedAt >= QUICK_ASK_MAX_LISTEN_MS) {
      return phase.speechStartedAt !== null
        ? { phase: { kind: "transcribing" }, effects: ["confirmDictation"] }
        : { phase: TYPING, effects: ["cancelDictation"] };
    }
    if (phase.speechStartedAt === null && event.now - phase.startedAt >= QUICK_ASK_NO_SPEECH_MS) {
      return { phase: TYPING, effects: ["cancelDictation"] };
    }
    return stay(phase);
  }
  if (event.type === "recordingStopped") {
    // The owner pressed the overlay's own accept (still processing) or cancel (not).
    return stay(event.processing ? { kind: "transcribing" } : TYPING);
  }
  if (event.type === "transcript") {
    return stepTranscript();
  }
  return stay(phase);
}

/** A transcript (or an empty one) ends the quick ask; the text stays in the composer. */
function stepTranscript(): QuickAskVoiceStep {
  return stay(TYPING);
}

export function stepQuickAskVoice(
  phase: QuickAskVoicePhase,
  event: QuickAskVoiceEvent,
): QuickAskVoiceStep {
  switch (phase.kind) {
    case "waitingForDictation":
      if (event.type !== "tick") {
        return stay(phase);
      }
      if (event.dictationReady) {
        return { phase: { kind: "starting", since: event.now }, effects: ["startDictation"] };
      }
      return stay(event.now - phase.since >= QUICK_ASK_DICTATION_START_MS ? TYPING : phase);
    case "starting":
      if (event.type === "recordingStarted") {
        return stay({
          kind: "listening",
          startedAt: event.now,
          speechStartedAt: null,
          lastSpeechAt: null,
        });
      }
      if (event.type === "tick" && event.now - phase.since >= QUICK_ASK_DICTATION_START_MS) {
        return stay(TYPING);
      }
      return stay(phase);
    case "listening":
      return stepListening(phase, event);
    case "transcribing":
      if (event.type === "transcript") {
        return stepTranscript();
      }
      if (event.type === "recordingStopped" && !event.processing) {
        // Processing ended without a transcript: nothing was recognized, or it failed.
        return stay(TYPING);
      }
      return stay(phase);
    case "done":
      return stay(phase);
  }
}
