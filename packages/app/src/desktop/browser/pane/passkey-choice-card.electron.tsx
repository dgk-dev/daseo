// Daseo delta 102: the person asked a site to sign in with a passkey and two or more stored accounts
// fit, so the tab's pane asks which one, the way a browser's passkey sheet does. Shown inside the
// tab's own pane like a delta 93 page dialog; nothing else in the window changes.
import { createElement, useCallback, useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { DesktopBrowserPasskeyChoice } from "@/desktop/host";

export function passkeyAccountLabel(
  account: DesktopBrowserPasskeyChoice["accounts"][number],
): string {
  const { userName, userDisplayName } = account;
  if (userDisplayName && userName && userDisplayName !== userName) {
    return `${userDisplayName} (${userName})`;
  }
  return userDisplayName || userName || account.credentialId.slice(0, 12);
}

export function BrowserPasskeyChoiceCard({
  choice,
  takeFocus,
  onAnswer,
}: {
  choice: DesktopBrowserPasskeyChoice;
  /** Focus the card when it appears: only when the person was already in this pane. */
  takeFocus: boolean;
  /** An account's credential id, or null for Cancel. */
  onAnswer: (credentialId: string | null) => void;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const title = t("workspace.browser.passkeyChoice.title", { host: choice.rpId });

  const cancel = useCallback(() => onAnswer(null), [onAnswer]);

  useEffect(() => {
    if (takeFocus) containerRef.current?.focus();
  }, [choice.id, takeFocus]);

  const handleKeyDown = useCallback(
    (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    },
    [cancel],
  );

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {createElement(
        "div",
        {
          ref: containerRef,
          tabIndex: -1,
          role: "dialog",
          "aria-label": title,
          "data-testid": "browser-passkey-choice",
          onKeyDown: handleKeyDown,
          style: CARD_FOCUS_RING_STYLE,
        },
        <View style={styles.card}>
          <Text numberOfLines={1} style={styles.title}>
            {title}
          </Text>
          <Text style={styles.message}>{t("workspace.browser.passkeyChoice.message")}</Text>
          <View style={styles.accounts}>
            {choice.accounts.map((account) => (
              <PasskeyAccountButton
                key={account.credentialId}
                account={account}
                onAnswer={onAnswer}
              />
            ))}
          </View>
          <View style={styles.actions}>
            <Button variant="ghost" size="sm" onPress={cancel}>
              {t("workspace.browser.passkeyChoice.cancel")}
            </Button>
          </View>
        </View>,
      )}
    </View>
  );
}

function PasskeyAccountButton({
  account,
  onAnswer,
}: {
  account: DesktopBrowserPasskeyChoice["accounts"][number];
  onAnswer: (credentialId: string | null) => void;
}) {
  const pick = useCallback(() => onAnswer(account.credentialId), [account.credentialId, onAnswer]);
  return (
    <Button
      variant="secondary"
      size="sm"
      onPress={pick}
      testID={`browser-passkey-choice-${account.credentialId}`}
    >
      {passkeyAccountLabel(account)}
    </Button>
  );
}

// The card container takes focus for Escape; its own outline would draw around the whole card.
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
  message: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  accounts: {
    gap: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
}));
