import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { Keyboard } from "react-native";
import { isNative } from "@/constants/platform";
import {
  initialQuickAskVoicePhase,
  quickAskCountdownRemainingMs,
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
  send: () => void;
  onFinished: () => void;
}

export interface QuickAskVoiceOutput {
  countdownRemainingMs: number | null;
  cancelCountdown: () => void;
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

/** Daseo delta 64: drives one quick ask (dictate → countdown → send) on top of the composer. */
export function useQuickAskVoice(input: QuickAskVoiceInput): QuickAskVoiceOutput {
  const inputRef = useRef(input);
  inputRef.current = input;
  const phaseRef = useRef<QuickAskVoicePhase | null>(null);
  const stopKeyboardRetryRef = useRef<() => void>(() => {});
  const [countdownRemainingMs, setCountdownRemainingMs] = useState<number | null>(null);

  const runEffects = useCallback((effects: QuickAskVoiceEffect[]) => {
    const current = inputRef.current;
    for (const effect of effects) {
      if (effect === "startDictation") void current.startDictation();
      if (effect === "confirmDictation") void current.confirmDictation();
      if (effect === "cancelDictation") void current.cancelDictation();
      if (effect === "send") current.send();
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
      setCountdownRemainingMs(quickAskCountdownRemainingMs(step.phase, Date.now()));
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
    if (!input.active || phaseRef.current) {
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
        setCountdownRemainingMs(null);
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

  const cancelCountdown = useCallback(() => {
    dispatch({ type: "cancelCountdown" });
  }, [dispatch]);

  const onTranscript = useCallback(
    (text: string) => {
      dispatch({ type: "transcript", text, now: Date.now() });
    },
    [dispatch],
  );

  return { countdownRemainingMs, cancelCountdown, onTranscript };
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
  send: () => void;
  /** The input calls these from its transcript and edit handlers. */
  transcriptRef: MutableRefObject<((text: string) => void) | null>;
  cancelRef: MutableRefObject<(() => void) | null>;
}

/** The composer's side of quick ask: readiness, controls, and the input's callback refs. */
export function useComposerQuickAsk(input: ComposerQuickAskInput): QuickAskVoiceOutput {
  const request = input.request ?? null;
  const voice = useQuickAskVoice({
    active:
      request !== null &&
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
    send: input.send,
    onFinished: () => request?.onFinished(),
  });
  input.transcriptRef.current = request ? voice.onTranscript : null;
  input.cancelRef.current = request ? voice.cancelCountdown : null;
  return voice;
}
