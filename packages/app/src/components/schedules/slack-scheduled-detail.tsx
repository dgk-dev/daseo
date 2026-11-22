import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { SLACK_SCHEDULED_TEXT_MAX_CHARS } from "@getpaseo/protocol/slack-scheduled-limits";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { FormTextInput } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { SlackScheduledActions } from "@/hooks/use-slack-scheduled";
import {
  fromEditableSlackText,
  slackDisplaySegments,
  toEditableSlackText,
} from "@/schedules/slack-message-text";
import {
  describeSlackTime,
  formatSlackTimeInput,
  parseSlackTimeInput,
  slackQuickTimes,
  type SlackQuickTime,
} from "@/schedules/slack-post-time";
import {
  slackEntryLink,
  slackEntryText,
  type AggregatedSlackScheduled,
  type SlackScheduledActionResult,
  type SlackScheduledChange,
} from "@/schedules/slack-scheduled";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openSlackMessage } from "@/utils/open-slack-message";

type Busy = "cancel" | "time" | "text" | null;
type Mode = "view" | "time" | "text";

interface SlackScheduledDetailProps {
  entry: AggregatedSlackScheduled;
  /** The entry's host can cancel and change (server_info.features.slackScheduledActions). */
  canChange: boolean;
  actions: SlackScheduledActions;
  /** After a successful action: the id to keep open (a change's new id), or null to close. */
  onDone: (openId: string | null) => void;
}

/**
 * Daseo delta 135 (2026-11-23): an open row of the Slack filter. The whole message as Slack shows
 * it (mentions as @이름, links as their label), a way to open a sent message in Slack, and on an
 * upcoming one the owner's 취소, 시간 변경, and 내용 수정. Mounted only while its row is open.
 */
export function SlackScheduledDetail({
  entry,
  canChange,
  actions,
  onDone,
}: SlackScheduledDetailProps): ReactElement {
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const text = slackEntryText(entry);
  // Keyed by where each segment starts in the display text (stable for one text).
  const segments = useMemo(() => {
    let offset = 0;
    return slackDisplaySegments(text, entry.mentions).map((segment) => {
      const key = `${segment.kind}:${offset}`;
      offset += segment.text.length;
      return { kind: segment.kind, text: segment.text, key };
    });
  }, [text, entry.mentions]);
  const link = useMemo(() => slackEntryLink(entry), [entry]);
  const upcoming = entry.status === "scheduled" && canChange;
  // A text at the cap may have been cut on the way here; saving it would schedule the cut message.
  const tooLongToEdit = useMemo(
    () => Array.from(text).length >= SLACK_SCHEDULED_TEXT_MAX_CHARS,
    [text],
  );

  const settle = useCallback(
    (kind: Exclude<Busy, null>, result: SlackScheduledActionResult) => {
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setMode("view");
      onDone(kind === "cancel" ? null : (result.newId ?? entry.id));
    },
    [entry.id, onDone],
  );

  const handleCancel = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: "예약 취소",
        message: "이 예약을 취소할까요? 아무에게도 보내지 않습니다",
        confirmLabel: "예약 취소",
        cancelLabel: "닫기",
        destructive: true,
      });
      if (!confirmed) return;
      setBusy("cancel");
      setError(null);
      settle("cancel", await actions.cancel(entry));
    })();
  }, [actions, entry, settle]);

  const handleSave = useCallback(
    (kind: "time" | "text", change: SlackScheduledChange) => {
      void (async () => {
        setBusy(kind);
        setError(null);
        settle(kind, await actions.update(entry, change));
      })();
    },
    [actions, entry, settle],
  );

  const openTime = useCallback(() => {
    setError(null);
    setMode("time");
  }, []);
  const openText = useCallback(() => {
    setError(null);
    setMode("text");
  }, []);
  const closeEditor = useCallback(() => {
    setError(null);
    setMode("view");
  }, []);
  const handleOpenInSlack = useCallback(() => {
    if (link) void openSlackMessage(link);
  }, [link]);

  return (
    <View style={styles.container} testID={`slack-scheduled-detail-${entry.id}`}>
      <Text style={styles.body} selectable testID={`slack-scheduled-text-${entry.id}`}>
        {segments.map((segment) =>
          segment.kind === "text" ? (
            segment.text
          ) : (
            <Text key={segment.key} style={styles.mention}>
              {segment.text}
            </Text>
          ),
        )}
      </Text>
      {link ? (
        <View style={styles.actions}>
          <Button
            variant="outline"
            size="sm"
            onPress={handleOpenInSlack}
            testID={`slack-scheduled-open-${entry.id}`}
          >
            슬랙에서 열기
          </Button>
        </View>
      ) : null}
      {upcoming && mode === "view" ? (
        <View style={styles.actions}>
          <Button
            variant="destructive"
            size="sm"
            onPress={handleCancel}
            loading={busy === "cancel"}
            disabled={busy !== null}
            testID={`slack-scheduled-cancel-${entry.id}`}
          >
            취소
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={openTime}
            disabled={busy !== null}
            testID={`slack-scheduled-time-${entry.id}`}
          >
            시간 변경
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={openText}
            disabled={busy !== null || tooLongToEdit}
            testID={`slack-scheduled-edit-${entry.id}`}
          >
            내용 수정
          </Button>
        </View>
      ) : null}
      {upcoming && mode === "view" && tooLongToEdit ? (
        <Text style={styles.hint} testID={`slack-scheduled-too-long-${entry.id}`}>
          글이 너무 길어 여기서 고칠 수 없습니다 (채팅에서 요청)
        </Text>
      ) : null}
      {upcoming && mode === "time" ? (
        <SlackTimeEditor
          entry={entry}
          busy={busy === "time"}
          onSave={handleSave}
          onClose={closeEditor}
        />
      ) : null}
      {upcoming && mode === "text" ? (
        <SlackTextEditor
          entry={entry}
          text={text}
          busy={busy === "text"}
          onSave={handleSave}
          onClose={closeEditor}
        />
      ) : null}
      {error ? (
        <Text style={styles.error} testID={`slack-scheduled-action-error-${entry.id}`}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

interface EditorProps {
  entry: AggregatedSlackScheduled;
  busy: boolean;
  onSave: (kind: "time" | "text", change: SlackScheduledChange) => void;
  onClose: () => void;
}

function SlackTimeEditor({ entry, busy, onSave, onClose }: EditorProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const [input, setInput] = useState(() => formatSlackTimeInput(entry.postAt));
  const now = Date.now();
  const parsed = parseSlackTimeInput(input, now);
  const quickTimes = slackQuickTimes(parsed.ok ? parsed.postAt : entry.postAt, now);
  const canSave = parsed.ok && parsed.postAt !== entry.postAt && !busy;

  const choose = useCallback((postAt: number) => {
    const next = formatSlackTimeInput(postAt);
    inputRef.current?.replaceText(next);
    setInput(next);
  }, []);
  const handleSave = useCallback(() => {
    if (parsed.ok) onSave("time", { postAt: parsed.postAt });
  }, [onSave, parsed]);

  return (
    <View style={styles.editor} testID={`slack-scheduled-time-editor-${entry.id}`}>
      <FormTextInput
        ref={inputRef}
        size={isCompact ? "md" : "sm"}
        initialValue={input}
        onChangeText={setInput}
        accessibilityLabel="보낼 시각 (한국 시각)"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        testID={`slack-scheduled-time-input-${entry.id}`}
      />
      <View style={styles.quickRow}>
        {quickTimes.map((quick) => (
          <QuickTimeButton
            key={quick.key}
            quick={quick}
            disabled={busy}
            onChoose={choose}
            testID={`slack-scheduled-quick-${quick.key}-${entry.id}`}
          />
        ))}
      </View>
      <Text
        style={parsed.ok ? styles.hint : styles.error}
        testID={`slack-scheduled-time-read-${entry.id}`}
      >
        {parsed.ok ? describeSlackTime(parsed.postAt, now) : parsed.error}
      </Text>
      <View style={styles.actions}>
        <Button
          variant="default"
          size="sm"
          onPress={handleSave}
          loading={busy}
          disabled={!canSave}
          testID={`slack-scheduled-time-save-${entry.id}`}
        >
          저장
        </Button>
        <Button variant="ghost" size="sm" onPress={onClose} disabled={busy}>
          닫기
        </Button>
      </View>
    </View>
  );
}

function QuickTimeButton({
  quick,
  disabled,
  onChoose,
  testID,
}: {
  quick: SlackQuickTime;
  disabled: boolean;
  onChoose: (postAt: number) => void;
  testID: string;
}): ReactElement {
  const handlePress = useCallback(() => onChoose(quick.postAt), [onChoose, quick.postAt]);
  return (
    <Button variant="ghost" size="xs" disabled={disabled} onPress={handlePress} testID={testID}>
      {quick.label}
    </Button>
  );
}

function SlackTextEditor({
  entry,
  text,
  busy,
  onSave,
  onClose,
}: EditorProps & { text: string }): ReactElement {
  const isCompact = useIsCompactFormFactor();
  // Built once per open: a list refresh while editing must not change what the editor maps back.
  const [editable] = useState(() => toEditableSlackText(text, entry.mentions));
  const [draft, setDraft] = useState(editable.editable);
  const wire = fromEditableSlackText(draft, editable.names);
  const canSave = draft.trim().length > 0 && wire !== text && !busy;
  const handleSave = useCallback(() => {
    onSave("text", { text: wire });
  }, [onSave, wire]);

  return (
    <View style={styles.editor} testID={`slack-scheduled-text-editor-${entry.id}`}>
      <FormTextInput
        size={isCompact ? "md" : "sm"}
        initialValue={editable.editable}
        onChangeText={setDraft}
        accessibilityLabel="보낼 내용"
        multiline
        numberOfLines={6}
        textAlignVertical="top"
        editable={!busy}
        style={styles.multiline}
        testID={`slack-scheduled-text-input-${entry.id}`}
      />
      <Text style={styles.hint}>새 사람 태그는 여기서 추가할 수 없습니다 (채팅에서 요청)</Text>
      <View style={styles.actions}>
        <Button
          variant="default"
          size="sm"
          onPress={handleSave}
          loading={busy}
          disabled={!canSave}
          testID={`slack-scheduled-text-save-${entry.id}`}
        >
          저장
        </Button>
        <Button variant="ghost" size="sm" onPress={onClose} disabled={busy}>
          닫기
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Lines up with the row's text column (row padding, leading icon 16, gap).
  container: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[4],
    paddingLeft: theme.spacing[4] + 16 + theme.spacing[3],
    paddingRight: theme.spacing[4],
  },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  mention: {
    color: theme.colors.accent,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  editor: {
    gap: theme.spacing[2],
  },
  quickRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  multiline: {
    minHeight: 120,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
}));
