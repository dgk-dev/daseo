import { i18n } from "@/i18n/i18next";
import { formatDuration } from "@/utils/time";

export interface CompactionMarkerLabelInput {
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
  /** Start of the compaction; absent on rows recorded before it was tracked. */
  startedAt?: Date;
  /** Completion time of the compaction, i.e. the completed row's timestamp. */
  completedAt?: Date;
  outcome?: "failed" | "canceled";
  error?: string;
}

/**
 * How long the context took to shrink, appended only to a successful marker.
 * A failed or interrupted compaction did not finish, so its elapsed time says
 * nothing a reader can use.
 */
function getCompactionDurationSuffix(startedAt?: Date, completedAt?: Date): string {
  if (!startedAt || !completedAt) return "";
  const durationMs = completedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "";
  return ` · ${formatDuration(durationMs)}`;
}

export function getCompactionMarkerLabel({
  status,
  trigger,
  preTokens,
  startedAt,
  completedAt,
  outcome,
  error,
}: CompactionMarkerLabelInput): string {
  if (status === "loading") return i18n.t("message.compaction.loading");
  // A compaction that failed or was interrupted did not shrink the context.
  // Saying it did hides why the next turn still runs against a full window.
  if (outcome === "failed") {
    const failed = i18n.t("message.compaction.failed");
    return error ? `${failed}: ${error}` : failed;
  }
  if (outcome === "canceled") return i18n.t("message.compaction.canceled");
  const duration = getCompactionDurationSuffix(startedAt, completedAt);
  if (trigger === "auto") return `${i18n.t("message.compaction.auto")}${duration}`;
  if (trigger === "manual") return `${i18n.t("message.compaction.manual")}${duration}`;
  if (preTokens) {
    return `${i18n.t("message.compaction.withTokens", {
      tokens: Math.round(preTokens / 1000),
    })}${duration}`;
  }
  return `${i18n.t("message.compaction.completed")}${duration}`;
}
