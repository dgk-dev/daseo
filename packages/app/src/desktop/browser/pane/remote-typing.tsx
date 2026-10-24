import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Keyboard } from "lucide-react-native";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useKeyboardHeight } from "@/hooks/use-keyboard-height";
import { diffTypedText, shouldResetTypedText } from "./remote-keyboard";

// Daseo delta 60: typing into the streamed page from the phone. `keyboardMode` keeps an
// invisible field focused so the phone keyboard is up; the field's text is mirrored into the
// page's focused field by diff (see remote-keyboard.ts), Enter and Backspace go as keys.

export type RemoteKey =
  | "Enter"
  | "Backspace"
  | "Tab"
  | "Escape"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Delete";

export type RemoteTypingInput = { kind: "text"; text: string } | { kind: "key"; key: RemoteKey };

export interface RemoteTypingFocus {
  editable: boolean;
  multiline?: boolean;
  inputType?: string;
}

// The keys a phone keyboard has no button for, shown above it while typing.
const REMOTE_KEY_ROW: ReadonlyArray<{ key: RemoteKey; label: string }> = [
  { key: "Escape", label: "Esc" },
  { key: "Tab", label: "Tab" },
  { key: "ArrowLeft", label: "←" },
  { key: "ArrowUp", label: "↑" },
  { key: "ArrowDown", label: "↓" },
  { key: "ArrowRight", label: "→" },
  { key: "Delete", label: "Del" },
];

const SCROLL_BAR_LIFT_ABOVE_KEY_ROW = 56;

export interface RemoteTyping {
  keyboardMode: boolean;
  /** Height the page viewport must give up to the keyboard and key row; 0 when off. */
  keyboardInset: number;
  toggle(): void;
  /** Apply what the host reported the page focused after a tap. */
  applyFocus(focus: RemoteTypingFocus | undefined): void;
  layer: ReactElement | null;
}

export function useRemoteTyping(input: {
  sendInput: (input: RemoteTypingInput) => Promise<unknown>;
  /** Changes reset the mode: a different tab has its own focus. */
  targetKey: string;
}): RemoteTyping {
  const { sendInput, targetKey } = input;
  const [keyboardMode, setKeyboardMode] = useState(false);
  const keyboardHeight = useKeyboardHeight();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const typedRef = useRef("");

  const resetTyped = useCallback(() => {
    typedRef.current = "";
    inputRef.current?.replaceText("");
  }, []);

  useEffect(() => {
    if (!keyboardMode) {
      resetTyped();
      inputRef.current?.blur();
      return;
    }
    inputRef.current?.focus();
  }, [keyboardMode, resetTyped]);

  useEffect(() => {
    setKeyboardMode(false);
  }, [targetKey]);

  const applyFocus = useCallback(
    (focus: RemoteTypingFocus | undefined) => {
      if (!focus) {
        return;
      }
      if (focus.editable) {
        resetTyped();
        setKeyboardMode(true);
        return;
      }
      setKeyboardMode(false);
    },
    [resetTyped],
  );

  const toggle = useCallback(() => setKeyboardMode((current) => !current), []);

  const handleChangeText = useCallback(
    (next: string) => {
      const step = diffTypedText(typedRef.current, next);
      typedRef.current = next;
      for (let index = 0; index < step.deleteCount; index += 1) {
        void sendInput({ kind: "key", key: "Backspace" });
      }
      if (step.insert) {
        void sendInput({ kind: "text", text: step.insert });
      }
      if (shouldResetTypedText(next)) {
        resetTyped();
      }
    },
    [resetTyped, sendInput],
  );

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = event.nativeEvent.key;
      if (key === "Backspace" && typedRef.current.length === 0) {
        void sendInput({ kind: "key", key: "Backspace" });
      } else if (key === "Enter") {
        resetTyped();
        void sendInput({ kind: "key", key: "Enter" });
      }
    },
    [resetTyped, sendInput],
  );

  // The keyboard went away by itself (back gesture, a sheet). Reflect it.
  const handleBlur = useCallback(() => setKeyboardMode(false), []);

  const sendKey = useCallback(
    (key: RemoteKey) => {
      resetTyped();
      void sendInput({ kind: "key", key });
      inputRef.current?.focus();
    },
    [resetTyped, sendInput],
  );

  const keyRowStyle = useMemo(() => [styles.keyRow, { bottom: keyboardHeight }], [keyboardHeight]);

  const layer = useMemo(
    () =>
      keyboardMode ? (
        <>
          <View style={keyRowStyle}>
            {REMOTE_KEY_ROW.map((entry) => (
              <RemoteKeyButton
                key={entry.key}
                remoteKey={entry.key}
                label={entry.label}
                onPress={sendKey}
              />
            ))}
            <DoneButton onPress={toggle} />
          </View>
          <HiddenTypingField
            inputRef={inputRef}
            onChangeText={handleChangeText}
            onKeyPress={handleKeyPress}
            onBlur={handleBlur}
          />
        </>
      ) : null,
    [handleBlur, handleChangeText, handleKeyPress, keyRowStyle, keyboardMode, sendKey, toggle],
  );

  return useMemo(
    () => ({
      keyboardMode,
      keyboardInset: keyboardMode ? keyboardHeight + SCROLL_BAR_LIFT_ABOVE_KEY_ROW : 0,
      toggle,
      applyFocus,
      layer,
    }),
    [applyFocus, keyboardHeight, keyboardMode, layer, toggle],
  );
}

export function RemoteKeyboardToggle({
  typing,
  color,
  activeColor,
}: {
  typing: RemoteTyping;
  color: string;
  activeColor: string;
}) {
  const { t } = useTranslation();
  const accessibilityState = useMemo(
    () => ({ selected: typing.keyboardMode }),
    [typing.keyboardMode],
  );
  return (
    <Pressable
      onPress={typing.toggle}
      style={styles.toolbarButton}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={
        typing.keyboardMode
          ? t("workspace.browser.controls.hideKeyboard")
          : t("workspace.browser.controls.showKeyboard")
      }
    >
      <Keyboard size={18} color={typing.keyboardMode ? activeColor : color} />
    </Pressable>
  );
}

function RemoteKeyButton({
  remoteKey,
  label,
  onPress,
}: {
  remoteKey: RemoteKey;
  label: string;
  onPress: (key: RemoteKey) => void;
}) {
  const handlePress = useCallback(() => onPress(remoteKey), [onPress, remoteKey]);
  return (
    <Pressable
      onPress={handlePress}
      style={styles.keyButton}
      accessibilityRole="button"
      accessibilityLabel={remoteKey}
    >
      <Text style={styles.keyLabel}>{label}</Text>
    </Pressable>
  );
}

function DoneButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      style={styles.keyButton}
      accessibilityRole="button"
      accessibilityLabel={t("workspace.browser.controls.hideKeyboard")}
    >
      <Text style={styles.doneLabel}>{t("workspace.browser.controls.done")}</Text>
    </Pressable>
  );
}

function HiddenTypingField({
  inputRef,
  onChangeText,
  onKeyPress,
  onBlur,
}: {
  inputRef: React.MutableRefObject<EditingTextInputHandle | null>;
  onChangeText: (text: string) => void;
  onKeyPress: (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => void;
  onBlur: () => void;
}) {
  const { t } = useTranslation();
  return (
    <EditingTextInput
      ref={inputRef}
      style={styles.typingInput}
      initialValue=""
      onChangeText={onChangeText}
      onKeyPress={onKeyPress}
      onBlur={onBlur}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      spellCheck={false}
      submitBehavior="submit"
      returnKeyType="go"
      importantForAutofill="no"
      accessibilityLabel={t("workspace.browser.controls.typeIntoPage")}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbarButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  keyRow: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
    minHeight: 44,
    paddingHorizontal: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  keyButton: {
    minWidth: 40,
    height: 36,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  keyLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  doneLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  // Off screen but focusable: an invisible field keeps the phone keyboard up and collects
  // what it types; the page shows the text, this field never does.
  typingInput: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: 1,
    height: 1,
    opacity: 0,
    color: "transparent",
  },
}));
