import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n/i18next";
import { getCompactionMarkerLabel } from "./message-compaction-label";

describe("getCompactionMarkerLabel", () => {
  it("renders loading, automatic, manual, tokenized, and fallback labels", () => {
    expect(getCompactionMarkerLabel({ status: "loading" })).toBe("Compacting...");
    expect(getCompactionMarkerLabel({ status: "completed", trigger: "auto" })).toBe(
      "Context automatically compacted",
    );
    expect(getCompactionMarkerLabel({ status: "completed", trigger: "manual" })).toBe(
      "Context manually compacted",
    );
    expect(getCompactionMarkerLabel({ status: "completed", preTokens: 12_345 })).toBe(
      "Context compacted (12K tokens)",
    );
    expect(getCompactionMarkerLabel({ status: "completed" })).toBe("Context compacted");
  });

  it("never reports an interrupted or failed compaction as done", () => {
    expect(
      getCompactionMarkerLabel({ status: "completed", trigger: "auto", outcome: "canceled" }),
    ).toBe("Context compaction interrupted");
    expect(getCompactionMarkerLabel({ status: "completed", outcome: "failed" })).toBe(
      "Context compaction failed",
    );
    expect(
      getCompactionMarkerLabel({
        status: "completed",
        outcome: "failed",
        error: "Prompt is too long",
      }),
    ).toBe("Context compaction failed: Prompt is too long");
  });

  it("reports how long a successful compaction took", () => {
    const startedAt = new Date("2026-09-17T10:50:00Z");
    const completedAt = new Date("2026-09-17T10:51:14Z");
    expect(
      getCompactionMarkerLabel({ status: "completed", trigger: "manual", startedAt, completedAt }),
    ).toBe("Context manually compacted · 1m 14s");
    expect(
      getCompactionMarkerLabel({ status: "completed", trigger: "auto", startedAt, completedAt }),
    ).toBe("Context automatically compacted · 1m 14s");
    expect(getCompactionMarkerLabel({ status: "completed", startedAt, completedAt })).toBe(
      "Context compacted · 1m 14s",
    );
  });

  it("omits the duration when it is unknown or the compaction did not finish", () => {
    const startedAt = new Date("2026-09-17T10:50:00Z");
    const completedAt = new Date("2026-09-17T10:51:14Z");
    // Rows recorded before the start time was tracked.
    expect(getCompactionMarkerLabel({ status: "completed", trigger: "manual", completedAt })).toBe(
      "Context manually compacted",
    );
    expect(
      getCompactionMarkerLabel({
        status: "completed",
        trigger: "manual",
        startedAt,
        completedAt,
        outcome: "canceled",
      }),
    ).toBe("Context compaction interrupted");
    expect(
      getCompactionMarkerLabel({
        status: "completed",
        trigger: "manual",
        startedAt,
        completedAt,
        outcome: "failed",
      }),
    ).toBe("Context compaction failed");
  });

  it("renders labels in the active app language", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      expect(getCompactionMarkerLabel({ status: "loading" })).toBe("正在压缩...");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
