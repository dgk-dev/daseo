import * as Clipboard from "expo-clipboard";
import { Copy, Eraser, GitBranchPlus } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import {
  selectSideQuestionExchanges,
  sideQuestionThreadKey,
  useSideQuestionStore,
  type SideQuestionExchange,
} from "@/side-question/store";

export interface SideQuestionSheetProps {
  serverId: string;
  agentId: string;
  /** Opens a fork of the agent in a new tab with `text` in its composer. */
  onContinueInFork?: (text: string) => Promise<void>;
}

/**
 * The `/btw` side thread for one agent. Answers come from the agent's current
 * conversation and never enter its timeline; the agent keeps working meanwhile.
 */
export function SideQuestionSheet({ serverId, agentId, onContinueInFork }: SideQuestionSheetProps) {
  const { t } = useTranslation();
  const key = sideQuestionThreadKey(serverId, agentId);
  const visible = useSideQuestionStore((state) => state.openKey === key);
  const exchanges = useSideQuestionStore((state) => selectSideQuestionExchanges(state, key));
  const close = useSideQuestionStore((state) => state.close);
  const ask = useSideQuestionStore((state) => state.ask);
  const clear = useSideQuestionStore((state) => state.clear);
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const [draft, setDraft] = useState("");
  const [inputResetKey, setInputResetKey] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // On phones the keyboard would cover the answer the sheet just opened for.
  const isCompact = useIsCompactFormFactor();

  const current = exchanges.at(-1) ?? null;
  const earlier = useMemo(() => exchanges.slice(0, -1).reverse(), [exchanges]);

  const handleAsk = useCallback(() => {
    const question = draft.trim();
    if (!question || !client) return;
    setDraft("");
    setInputResetKey((value) => value + 1);
    setActionError(null);
    void ask({ key, agentId, question, client });
  }, [agentId, ask, client, draft, key]);

  const handleCopy = useCallback(async () => {
    if (!current?.answer) return;
    await Clipboard.setStringAsync(current.answer);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [current]);

  const handleClear = useCallback(() => {
    setActionError(null);
    clear({ key, agentId, client }).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  }, [agentId, clear, client, key]);

  const handleFork = useCallback(() => {
    if (!onContinueInFork || !current?.answer) return;
    const text = t("sideQuestion.forkPrompt", {
      question: current.question,
      answer: current.answer,
    });
    setActionError(null);
    onContinueInFork(text)
      .then(() => close())
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
  }, [close, current, onContinueInFork, t]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("sideQuestion.title"),
      actions:
        exchanges.length > 0 ? (
          <View style={styles.headerActions}>
            <Button
              variant="ghost"
              size="xs"
              leftIcon={Copy}
              onPress={handleCopy}
              disabled={!current?.answer}
              testID="side-question-copy"
            >
              {copied ? t("sideQuestion.copied") : t("sideQuestion.copy")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              leftIcon={Eraser}
              onPress={handleClear}
              testID="side-question-clear"
            >
              {t("sideQuestion.clear")}
            </Button>
          </View>
        ) : undefined,
    }),
    [copied, current?.answer, exchanges.length, handleClear, handleCopy, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <View style={styles.inputSlot}>
          <AdaptiveTextInput
            autoFocus={!isCompact}
            initialValue=""
            resetKey={inputResetKey}
            onChangeText={setDraft}
            placeholder={t("sideQuestion.placeholder")}
            onSubmitEditing={handleAsk}
            returnKeyType="send"
            style={styles.input}
            testID="side-question-input"
          />
        </View>
        <Button
          variant="secondary"
          size="sm"
          onPress={handleAsk}
          disabled={!draft.trim() || !client}
          testID="side-question-ask"
        >
          {t("sideQuestion.ask")}
        </Button>
      </View>
    ),
    [client, draft, handleAsk, inputResetKey, isCompact, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={close}
      footer={footer}
      desktopMaxWidth={640}
      // Keeps the ask field on screen at the sheet's first (shorter) snap point.
      sizeContentToCurrentSnapPoint
      testID="side-question-sheet"
    >
      {/* In the body rather than the header subtitle, where the header actions squeeze it on phones. */}
      <Text style={styles.subtitle}>{t("sideQuestion.hint")}</Text>
      {current ? (
        <CurrentExchange
          exchange={current}
          onContinueInFork={onContinueInFork && current.answer ? handleFork : undefined}
        />
      ) : (
        <Text style={styles.muted}>{t("sideQuestion.empty")}</Text>
      )}
      {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
      {earlier.length > 0 ? (
        <View style={styles.earlier}>
          <Text style={styles.sectionLabel}>{t("sideQuestion.earlier")}</Text>
          {earlier.map((exchange) => (
            <View key={exchange.id} style={styles.earlierItem}>
              <Text style={styles.question}>› {exchange.question}</Text>
              <Text style={styles.muted} numberOfLines={6}>
                {exchange.answer ?? exchange.error ?? t("sideQuestion.answering")}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function CurrentExchange({
  exchange,
  onContinueInFork,
}: {
  exchange: SideQuestionExchange;
  onContinueInFork?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.current} testID="side-question-current">
      <Text style={styles.question}>› {exchange.question}</Text>
      {exchange.status === "pending" ? (
        <Text style={styles.muted}>{t("sideQuestion.answering")}</Text>
      ) : null}
      {exchange.status === "failed" ? (
        <Text style={styles.error}>{exchange.error ?? t("sideQuestion.failed")}</Text>
      ) : null}
      {exchange.status === "answered" && exchange.answer ? (
        <View style={styles.answer} testID="side-question-answer">
          <MarkdownRenderer text={exchange.answer} />
        </View>
      ) : null}
      {onContinueInFork ? (
        <View style={styles.currentActions}>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={GitBranchPlus}
            onPress={onContinueInFork}
            testID="side-question-fork"
          >
            {t("sideQuestion.continueInFork")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  footer: {
    // The sheet's footer container is itself a row; take its full width.
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inputSlot: {
    flex: 1,
    minWidth: 0,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  input: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  current: {
    gap: theme.spacing[2],
  },
  question: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  answer: {
    minWidth: 0,
  },
  currentActions: {
    flexDirection: "row",
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  earlier: {
    gap: theme.spacing[3],
    marginTop: theme.spacing[4],
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  earlierItem: {
    gap: theme.spacing[1],
  },
}));
