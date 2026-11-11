// Daseo delta 93: a page's alert, confirm, or prompt, shown inside the tab's own pane instead of a
// macOS sheet over the whole window. The pane renders it only where that tab's page is visible.
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import type { DesktopBrowserPageDialog } from "@/desktop/host";

const ThemedPromptInput = withUnistyles(TextInput);
const promptInputMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
});

export function pageDialogHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : null;
  } catch {
    return null;
  }
}

export function BrowserPageDialogCard({
  dialog,
  takeFocus,
  onAnswer,
}: {
  dialog: DesktopBrowserPageDialog;
  /** Focus the card when it appears: only when the person was already in this pane. */
  takeFocus: boolean;
  onAnswer: (accept: boolean, promptText?: string) => void;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const [promptText, setPromptText] = useState(dialog.defaultValue ?? "");
  const promptTextRef = useRef(promptText);
  promptTextRef.current = promptText;
  const host = pageDialogHost(dialog.url);

  const accept = useCallback(() => {
    onAnswer(true, dialog.type === "prompt" ? promptTextRef.current : undefined);
  }, [dialog.type, onAnswer]);
  // An alert has only OK; Escape answers it the same way, as browsers do.
  const cancel = useCallback(() => {
    onAnswer(dialog.type === "alert");
  }, [dialog.type, onAnswer]);

  useEffect(() => {
    if (!takeFocus) return;
    if (dialog.type === "prompt") inputRef.current?.focus();
    else containerRef.current?.focus();
  }, [dialog.id, dialog.type, takeFocus]);

  const handleKeyDown = useCallback(
    (event: {
      key: string;
      shiftKey: boolean;
      preventDefault(): void;
      stopPropagation(): void;
    }) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        accept();
      }
    },
    [accept, cancel],
  );

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {createElement(
        "div",
        {
          ref: containerRef,
          tabIndex: -1,
          role: dialog.type === "alert" ? "alertdialog" : "dialog",
          "aria-label": host
            ? t("workspace.browser.pageDialog.title", { host })
            : t("workspace.browser.pageDialog.titleNoHost"),
          "data-testid": "browser-page-dialog",
          onKeyDown: handleKeyDown,
          style: CARD_FOCUS_RING_STYLE,
        },
        <View style={styles.card}>
          <Text numberOfLines={1} style={styles.title}>
            {host
              ? t("workspace.browser.pageDialog.title", { host })
              : t("workspace.browser.pageDialog.titleNoHost")}
          </Text>
          <ScrollView style={styles.messageScroll}>
            <Text selectable style={styles.message}>
              {dialog.message}
            </Text>
          </ScrollView>
          {dialog.type === "prompt" ? (
            <ThemedPromptInput
              ref={inputRef}
              accessibilityLabel={t("workspace.browser.pageDialog.answer")}
              onChangeText={setPromptText}
              style={styles.input}
              uniProps={promptInputMapping}
              initialValue={dialog.defaultValue ?? ""}
            />
          ) : null}
          {dialog.holder === "agent" ? (
            <Text style={styles.note}>{t("workspace.browser.pageDialog.agentNote")}</Text>
          ) : null}
          <View style={styles.actions}>
            {dialog.type === "alert" ? null : (
              <Button variant="ghost" size="sm" onPress={cancel}>
                {t("workspace.browser.pageDialog.cancel")}
              </Button>
            )}
            <Button variant="default" size="sm" onPress={accept}>
              {t("workspace.browser.pageDialog.ok")}
            </Button>
          </View>
        </View>,
      )}
    </View>
  );
}

// The card container takes focus for Enter and Escape; its own outline would draw around the
// whole card.
const CARD_FOCUS_RING_STYLE = { outline: "none", width: "100%", maxWidth: 420 } as const;

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    zIndex: 2,
    left: 0,
    right: 0,
    top: 0,
    padding: theme.spacing[3],
    alignItems: "center",
  },
  card: {
    width: "100%",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  messageScroll: {
    maxHeight: 240,
  },
  message: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  input: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  note: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
