import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { AppState, Keyboard } from "react-native";
import { isNative } from "@/constants/platform";
import {
  initialQuickAskVoicePhase,
  stepQuickAskVoice,
  type QuickAskVoiceEffect,
  type QuickAskVoiceEvent,
  type QuickAskVoicePhase,
} from "./state";

const TICK_MS = 100;
// The window is not always ready for the soft keyboard when the draft first mounts (an early
// showSoftInput is ignored), so focus is asked again until the keyboard is actually up.
const KEYBOARD_RETRY_MS = 250;
const KEYBOARD_RETRIES = 8;

export interface QuickAskVoiceInput {
  /** True once the quick-ask draft is mounted, hydrated, focused and enabled. */
  active: boolean;
  isDictationReady: () => boolean;
  isRecording: boolean;
  isProcessing: boolean;
  volume: number;
  startDictation: () => Promise<void>;
  confirmDictation: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  focusInput: () => void;
  onFinished: () => void;
}

export interface QuickAskVoiceOutput {
  /** Called by the input when a dictation transcript lands in the composer. */
  onTranscript: (text: string) => void;
}

function focusWithKeyboard(focusInput: () => void): () => void {
  focusInput();
  if (!isNative) {
    return () => {};
  }
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (Keyboard.isVisible() || attempts > KEYBOARD_RETRIES) {
      clearInterval(timer);
      return;
    }
    focusInput();
  }, KEYBOARD_RETRY_MS);
  return () => clearInterval(timer);
}

/** Daseo delta 64: drives one quick ask (dictate into the composer) on top of the composer. */
export function useQuickAskVoice(input: QuickAskVoiceInput): QuickAskVoiceOutput {
  const inputRef = useRef(input);
  inputRef.current = input;
  const phaseRef = useRef<QuickAskVoicePhase | null>(null);
  const stopKeyboardRetryRef = useRef<() => void>(() => {});

  const runEffects = useCallback((effects: QuickAskVoiceEffect[]) => {
    const current = inputRef.current;
    for (const effect of effects) {
      if (effect === "startDictation") void current.startDictation();
      if (effect === "confirmDictation") void current.confirmDictation();
      if (effect === "cancelDictation") void current.cancelDictation();
    }
  }, []);

  const dispatch = useCallback(
    (event: QuickAskVoiceEvent) => {
      const phase = phaseRef.current;
      if (!phase || phase.kind === "done") {
        return;
      }
      const step = stepQuickAskVoice(phase, event);
      phaseRef.current = step.phase;
      runEffects(step.effects);
      if (step.phase.kind === "done") {
        if (step.phase.outcome === "typing") {
          stopKeyboardRetryRef.current();
          stopKeyboardRetryRef.current = focusWithKeyboard(inputRef.current.focusInput);
        }
        inputRef.current.onFinished();
      }
    },
    [runEffects],
  );

  // Start once, when the draft is ready: keyboard up first, then the tick loop starts dictation.
  // Losing readiness (pane hidden, unmount) ends the quick ask; the draft stays as typed.
  useEffect(() => {
    if (!input.active) {
      // A session's composer stays mounted between quick asks; a finished one makes way for the
      // next request on the same composer.
      if (phaseRef.current?.kind === "done") {
        phaseRef.current = null;
      }
      return;
    }
    if (phaseRef.current) {
      return;
    }
    phaseRef.current = initialQuickAskVoicePhase(Date.now());
    stopKeyboardRetryRef.current = focusWithKeyboard(inputRef.current.focusInput);
    const timer = setInterval(() => {
      if (phaseRef.current?.kind === "done") {
        clearInterval(timer);
        return;
      }
      dispatch({
        type: "tick",
        now: Date.now(),
        dictationReady: inputRef.current.isDictationReady(),
      });
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      const phase = phaseRef.current;
      // A finished quick ask may still be raising the keyboard for typing; let that finish.
      if (phase && phase.kind !== "done") {
        stopKeyboardRetryRef.current();
        phaseRef.current = { kind: "done", outcome: "typing" };
        inputRef.current.onFinished();
      }
    };
  }, [dispatch, input.active]);

  const wasCapturingRef = useRef(false);
  useEffect(() => {
    if (input.isRecording) {
      wasCapturingRef.current = true;
      dispatch({ type: "recordingStarted", now: Date.now() });
      return;
    }
    if (!wasCapturingRef.current) {
      return;
    }
    if (!input.isProcessing) {
      wasCapturingRef.current = false;
    }
    dispatch({ type: "recordingStopped", processing: input.isProcessing });
  }, [dispatch, input.isProcessing, input.isRecording]);

  useEffect(() => {
    if (input.isRecording) {
      dispatch({ type: "level", level: input.volume, now: Date.now() });
    }
  }, [dispatch, input.isRecording, input.volume]);

  const onTranscript = useCallback(
    (text: string) => {
      dispatch({ type: "transcript", text, now: Date.now() });
    },
    [dispatch],
  );

  return { onTranscript };
}

export interface ComposerQuickAskInput {
  request: { onFinished: () => void } | null | undefined;
  isPaneFocused: boolean;
  disabled: boolean;
  readOnly: boolean;
  isConnected: boolean;
  dictationUnavailableMessage: string | null | undefined;
  canStartDictation: () => boolean;
  isRecording: boolean;
  isProcessing: boolean;
  volume: number;
  startDictation: () => Promise<void>;
  confirmDictation: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  textInputRef: MutableRefObject<{ focus: () => void } | null>;
  /** The input calls this from its transcript handler. */
  transcriptRef: MutableRefObject<((text: string) => void) | null>;
}

/**
 * Daseo delta 70: true while Daseo is actually on screen. Android can hand the quick-ask link
 * to Daseo while it stays behind the lock screen or another app; the microphone then waits
 * until the owner sees Daseo, so it never records invisibly.
 */
function useAppIsActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
    });
    return () => subscription.remove();
  }, []);
  return active;
}

/** The composer's side of quick ask: readiness, controls, and the input's callback refs. */
export function useComposerQuickAsk(input: ComposerQuickAskInput): QuickAskVoiceOutput {
  const request = input.request ?? null;
  const appIsActive = useAppIsActive();
  const waitingForScreen = request !== null && !appIsActive;
  useEffect(() => {
    if (waitingForScreen) {
      console.info("[quick-ask] Daseo is not on screen yet; the microphone waits for it");
    }
  }, [waitingForScreen]);
  const voice = useQuickAskVoice({
    active:
      request !== null &&
      appIsActive &&
      input.isPaneFocused &&
      !input.disabled &&
      !input.readOnly &&
      input.isConnected,
    isDictationReady: () => !input.dictationUnavailableMessage && input.canStartDictation(),
    isRecording: input.isRecording,
    isProcessing: input.isProcessing,
    volume: input.volume,
    startDictation: input.startDictation,
    confirmDictation: input.confirmDictation,
    cancelDictation: input.cancelDictation,
    focusInput: () => input.textInputRef.current?.focus(),
    onFinished: () => request?.onFinished(),
  });
  input.transcriptRef.current = request ? voice.onTranscript : null;
  return voice;
}
