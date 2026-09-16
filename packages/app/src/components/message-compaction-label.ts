import { i18n } from "@/i18n/i18next";

export interface CompactionMarkerLabelInput {
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
  outcome?: "failed" | "canceled";
  error?: string;
}

export function getCompactionMarkerLabel({
  status,
  trigger,
  preTokens,
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
  if (trigger === "auto") return i18n.t("message.compaction.auto");
  if (trigger === "manual") return i18n.t("message.compaction.manual");
  if (preTokens) {
    return i18n.t("message.compaction.withTokens", {
      tokens: Math.round(preTokens / 1000),
    });
  }
  return i18n.t("message.compaction.completed");
}
