import { describe, expect, it } from "vitest";
import type { PaseoSubagentRow, ProviderSubagentRow, SubagentRow } from "./select";
import {
  buildSubagentRowPresentationData,
  buildTrackHeader,
  countFinishedSubagents,
  formatTrackHeaderText,
  resolveRowLabel,
  resolveSubagentRowDurationMs,
  resolveSubagentRowState,
  SUBAGENT_STATE_GLYPH,
  SUBAGENT_STATE_WORD,
  summarizeSubagentTrack,
} from "./track-presentation";

function row(
  overrides: Partial<PaseoSubagentRow> & Pick<PaseoSubagentRow, "id">,
): PaseoSubagentRow {
  return {
    kind: "paseo",
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    title: overrides.title ?? `Agent ${overrides.id}`,
    description: null,
    subtitle: null,
    status: overrides.status ?? "idle",
    requiresAttention: overrides.requiresAttention ?? false,
    createdAt: overrides.createdAt ?? new Date("2026-04-20T00:00:00.000Z"),
    ...(overrides.backgroundWaits ? { backgroundWaits: overrides.backgroundWaits } : {}),
    ...(overrides.needsInput ? { needsInput: true as const } : {}),
    ...(overrides.endedAt ? { endedAt: overrides.endedAt } : {}),
  };
}

function header(rows: SubagentRow[], elapsed: string | null = null): string {
  return formatTrackHeaderText(buildTrackHeader(summarizeSubagentTrack(rows), elapsed));
}

function nativeRow(
  overrides: Partial<ProviderSubagentRow> & Pick<ProviderSubagentRow, "id" | "status">,
): ProviderSubagentRow {
  return {
    kind: "provider",
    parentAgentId: "parent",
    provider: "claude",
    title: overrides.id,
    description: null,
    subtitle: null,
    requiresAttention: overrides.status === "failed",
    createdAt: T0,
    ...overrides,
  };
}

const T0 = new Date("2026-04-20T00:00:00.000Z");

describe("track header", () => {
  it("shows Running N/M and the elapsed time while a subagent runs", () => {
    const rows = [row({ id: "a", status: "running" }), row({ id: "b" }), row({ id: "c" })];
    expect(buildTrackHeader(summarizeSubagentTrack(rows), "2min 13s")).toEqual([
      { text: "[+]", tone: "prompt" },
      { text: " Running 1/3", tone: "strong" },
      { text: "  2min 13s", tone: "muted" },
    ]);
  });

  it("counts running, initializing and background-waiting rows as running", () => {
    expect(
      header([
        row({ id: "a", status: "running" }),
        row({ id: "b", status: "initializing" }),
        row({ id: "c", status: "idle", backgroundWaits: { pending: 1, labels: [] } }),
        nativeRow({ id: "d", status: "running" }),
        row({ id: "e", requiresAttention: true }),
      ]),
    ).toBe("[+] Running 4/5");
  });

  it("is a muted done line when nothing runs", () => {
    expect(header([row({ id: "a" })])).toBe("[+] 1 subagent · done");
    expect(
      buildTrackHeader(summarizeSubagentTrack([row({ id: "a" }), row({ id: "b" })]), null),
    ).toEqual([
      { text: "[+] 2 subagents", tone: "muted" },
      { text: " · done", tone: "muted" },
    ]);
  });

  it("counts failed rows in the destructive tone", () => {
    const rows = [
      row({ id: "a", status: "error" }),
      nativeRow({ id: "b", status: "failed" }),
      row({ id: "c" }),
    ];
    expect(buildTrackHeader(summarizeSubagentTrack(rows), null)).toEqual([
      { text: "[+] 3 subagents", tone: "muted" },
      { text: " · done", tone: "muted" },
      { text: " · 2 failed", tone: "destructive" },
    ]);
  });

  it("does not say done while a row waits on the user", () => {
    expect(header([row({ id: "a", needsInput: true }), row({ id: "b" })])).toBe(
      "[+] 2 subagents · 1 waiting",
    );
  });

  it("counts the elapsed time from the oldest running row", () => {
    const summary = summarizeSubagentTrack([
      row({ id: "done", createdAt: new Date(T0.getTime() - 60_000) }),
      row({ id: "new", status: "running", createdAt: new Date(T0.getTime() + 5_000) }),
      row({ id: "old", status: "running", createdAt: T0 }),
    ]);
    expect(summary.oldestRunningStartedAt).toBe(T0.getTime());
    expect(summarizeSubagentTrack([row({ id: "a" })]).oldestRunningStartedAt).toBeNull();
  });
});

describe("resolveSubagentRowState", () => {
  it("maps managed agents", () => {
    expect(resolveSubagentRowState(row({ id: "a", status: "running" }))).toBe("running");
    expect(resolveSubagentRowState(row({ id: "a", status: "initializing" }))).toBe("running");
    expect(resolveSubagentRowState(row({ id: "a", status: "idle" }))).toBe("done");
    expect(resolveSubagentRowState(row({ id: "a", status: "closed" }))).toBe("done");
    expect(resolveSubagentRowState(row({ id: "a", status: "error" }))).toBe("error");
    expect(
      resolveSubagentRowState(
        row({ id: "a", status: "idle", backgroundWaits: { pending: 2, labels: [] } }),
      ),
    ).toBe("running");
  });

  it("puts a row that needs input ahead of running and error", () => {
    expect(resolveSubagentRowState(row({ id: "a", status: "running", needsInput: true }))).toBe(
      "waiting",
    );
    expect(resolveSubagentRowState(row({ id: "a", status: "error", needsInput: true }))).toBe(
      "waiting",
    );
  });

  it("maps provider-owned subagents", () => {
    expect(resolveSubagentRowState(nativeRow({ id: "a", status: "running" }))).toBe("running");
    expect(resolveSubagentRowState(nativeRow({ id: "a", status: "completed" }))).toBe("done");
    expect(resolveSubagentRowState(nativeRow({ id: "a", status: "failed" }))).toBe("error");
    expect(resolveSubagentRowState(nativeRow({ id: "a", status: "canceled" }))).toBe("canceled");
  });

  it("has a word and a glyph for every state", () => {
    expect(SUBAGENT_STATE_WORD).toEqual({
      running: "Running",
      waiting: "Waiting",
      done: "Done",
      error: "Error",
      canceled: "Canceled",
    });
    expect(SUBAGENT_STATE_GLYPH.done).toBe("✔");
    expect(SUBAGENT_STATE_GLYPH.error).toBe("✘");
    expect(SUBAGENT_STATE_GLYPH.running).toBe("⠿");
  });
});

describe("resolveSubagentRowDurationMs", () => {
  const now = T0.getTime() + 133_000;

  it("counts a working row from its creation to now", () => {
    expect(resolveSubagentRowDurationMs(row({ id: "a", status: "running" }), now)).toBe(133_000);
  });

  it("shows a finished row's total up to its end", () => {
    expect(
      resolveSubagentRowDurationMs(row({ id: "a", endedAt: new Date(T0.getTime() + 62_000) }), now),
    ).toBe(62_000);
    expect(
      resolveSubagentRowDurationMs(
        nativeRow({ id: "a", status: "failed", endedAt: new Date(T0.getTime() + 280_000) }),
        now,
      ),
    ).toBe(280_000);
  });

  it("has no time for a finished row without a real end", () => {
    expect(resolveSubagentRowDurationMs(row({ id: "a" }), now)).toBeNull();
    expect(
      resolveSubagentRowDurationMs(row({ id: "a", endedAt: new Date(T0.getTime() - 1) }), now),
    ).toBeNull();
  });
});

describe("countFinishedSubagents", () => {
  it("counts eligible managed and terminal provider-owned children", () => {
    const providerRows: SubagentRow[] = [
      {
        kind: "provider",
        id: "native-running",
        parentAgentId: "parent",
        provider: "claude",
        title: "running",
        description: null,
        subtitle: null,
        status: "running",
        requiresAttention: false,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      {
        kind: "provider",
        id: "native-failed",
        parentAgentId: "parent",
        provider: "claude",
        title: "failed",
        description: null,
        subtitle: null,
        status: "failed",
        requiresAttention: true,
        createdAt: new Date("2026-04-20T00:00:01.000Z"),
      },
    ];

    expect(
      countFinishedSubagents([
        row({ id: "managed-running", status: "running" }),
        row({ id: "managed-idle", status: "idle" }),
        ...providerRows,
      ]),
    ).toBe(2);
  });

  it("excludes running and initializing managed children", () => {
    expect(
      countFinishedSubagents([
        row({ id: "running", status: "running" }),
        row({ id: "initializing", status: "initializing" }),
        row({ id: "finished", status: "idle" }),
      ]),
    ).toBe(1);
  });
});

describe("resolveRowLabel", () => {
  it("returns null when title is not a string", () => {
    expect(resolveRowLabel(null as unknown as SubagentRow["title"])).toBe(null);
  });

  it("returns null for whitespace-only titles", () => {
    expect(resolveRowLabel("   ")).toBe(null);
  });

  it("returns null for the placeholder 'new agent' regardless of case", () => {
    expect(resolveRowLabel("new agent")).toBe(null);
    expect(resolveRowLabel("New Agent")).toBe(null);
    expect(resolveRowLabel("  NEW AGENT  ")).toBe(null);
  });

  it("returns the trimmed title for real names", () => {
    expect(resolveRowLabel("  Build the thing  ")).toBe("Build the thing");
  });
});

describe("buildSubagentRowPresentationData", () => {
  it("namespaces the key with a subagent prefix", () => {
    expect(buildSubagentRowPresentationData(row({ id: "child-a" })).key).toBe(
      "paseo_subagent_child-a",
    );
  });

  it("marks the row ready when the title resolves to a real label", () => {
    const presentation = buildSubagentRowPresentationData(row({ id: "a", title: "Build it" }));
    expect(presentation.titleState).toBe("ready");
    expect(presentation.label).toBe("Build it");
  });

  it("marks the row loading and blanks the label for the placeholder title", () => {
    const presentation = buildSubagentRowPresentationData(row({ id: "a", title: "new agent" }));
    expect(presentation.titleState).toBe("loading");
    expect(presentation.label).toBe("");
  });

  it("maps a running row to the running status bucket so callers render the synced loader", () => {
    expect(buildSubagentRowPresentationData(row({ id: "a", status: "running" })).statusBucket).toBe(
      "running",
    );
  });

  it("maps an idle row to the done status bucket so callers render the static provider icon", () => {
    expect(buildSubagentRowPresentationData(row({ id: "a", status: "idle" })).statusBucket).toBe(
      "done",
    );
  });

  it("ignores requiresAttention on the source row when computing the bucket", () => {
    expect(
      buildSubagentRowPresentationData(row({ id: "a", status: "idle", requiresAttention: true }))
        .statusBucket,
    ).toBe("done");
  });
});

describe("buildSubagentRowPresentationData for provider rows", () => {
  function providerRow(overrides: Partial<ProviderSubagentRow> = {}): ProviderSubagentRow {
    return {
      kind: "provider",
      id: overrides.id ?? "toolu_1",
      parentAgentId: "parent",
      provider: "claude",
      title: "title" in overrides ? (overrides.title ?? null) : "general-purpose",
      description: overrides.description ?? null,
      subtitle: overrides.subtitle ?? null,
      status: overrides.status ?? "running",
      requiresAttention: false,
      createdAt: overrides.createdAt ?? new Date("2026-07-26T00:00:00.000Z"),
    };
  }

  it("names the row after the task and demotes the subagent type", () => {
    const presentation = buildSubagentRowPresentationData(
      providerRow({ title: "general-purpose", description: "Reply with banana" }),
    );
    expect(presentation.label).toBe("Reply with banana");
    expect(presentation.subtitle).toBe("general-purpose");
  });

  it("tells two siblings of the same type apart", () => {
    const left = buildSubagentRowPresentationData(
      providerRow({ id: "a", description: "Summarize the docs" }),
    );
    const right = buildSubagentRowPresentationData(
      providerRow({ id: "b", description: "Reply with banana" }),
    );
    expect(left.label).not.toBe(right.label);
  });

  it("keeps type-as-label and an empty subtitle when a provider reports no task", () => {
    const presentation = buildSubagentRowPresentationData(
      providerRow({ title: "Provider child", description: null }),
    );
    expect(presentation.label).toBe("Provider child");
    expect(presentation.subtitle).toBe("");
  });

  it("stays in the loading state when neither field is known", () => {
    const presentation = buildSubagentRowPresentationData(
      providerRow({ title: null, description: null }),
    );
    expect(presentation.titleState).toBe("loading");
  });

  it("leaves managed subagent rows with no subtitle", () => {
    expect(buildSubagentRowPresentationData(row({ id: "a", title: "Managed" })).subtitle).toBe("");
  });
});

describe("provider-owned row subtitles", () => {
  function providerRow(overrides: Partial<ProviderSubagentRow> = {}): ProviderSubagentRow {
    return {
      kind: "provider",
      id: "toolu_1",
      parentAgentId: "parent",
      provider: "claude",
      title: "general-purpose",
      description: "Reply with banana",
      subtitle: null,
      status: "running",
      requiresAttention: false,
      createdAt: new Date("2026-07-26T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("displays provider context without interpreting it", () => {
    expect(
      buildSubagentRowPresentationData(
        providerRow({ subtitle: "general-purpose · Opus 5 · High · 16.5k tokens" }),
      ).subtitle,
    ).toBe("general-purpose · Opus 5 · High · 16.5k tokens");
  });

  it("falls back to the type when an older provider sends no subtitle", () => {
    expect(buildSubagentRowPresentationData(providerRow()).subtitle).toBe("general-purpose");
  });

  it("does not duplicate the type when it is already the primary label", () => {
    expect(
      buildSubagentRowPresentationData(
        providerRow({ description: null, subtitle: null, title: "general-purpose" }),
      ).subtitle,
    ).toBe("");
  });
});
