import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentOutOfBandHost } from "../../agent-sdk-types.js";
import {
  formatPiSessionInfo,
  latestChangelogSection,
  resolvePiModelArgument,
  runPiBuiltinCommand,
  type PiBuiltinRuntime,
  type PiChangelog,
} from "./builtin-command-runner.js";
import type { PiModel, PiSessionState, PiSessionStats } from "./rpc-types.js";

const MODELS: PiModel[] = [
  { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { provider: "anthropic", id: "claude-fable-5-2", name: "Claude Fable 5.2" },
  { provider: "pi-codex", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
  { provider: "openrouter", id: "gpt-5.6-sol", name: "GPT 5.6 Sol (OpenRouter)" },
];

function baseState(overrides: Partial<PiSessionState> = {}): PiSessionState {
  return {
    model: MODELS[0],
    thinkingLevel: "high",
    isStreaming: false,
    isCompacting: false,
    sessionId: "session-1",
    messageCount: 4,
    pendingMessageCount: 0,
    ...overrides,
  };
}

class FakeRuntime implements PiBuiltinRuntime {
  state = baseState();
  stats: PiSessionStats = {};
  levels = ["off", "low", "medium", "high"];
  readonly requests: Array<{ type: string; [key: string]: unknown }> = [];

  async getState(): Promise<PiSessionState> {
    return this.state;
  }
  async getSessionStats(): Promise<PiSessionStats> {
    return this.stats;
  }
  async getAvailableModels(): Promise<PiModel[]> {
    return MODELS;
  }
  async request(command: { type: string; [key: string]: unknown }): Promise<unknown> {
    this.requests.push(command);
    if (command.type === "get_available_thinking_levels") return { levels: this.levels };
    if (command.type === "export_html") {
      return { path: typeof command.outputPath === "string" ? command.outputPath : "/w/out.html" };
    }
    return {};
  }
}

interface RunResult {
  texts: string[];
  calls: string[];
  runtime: FakeRuntime;
}

async function run(
  name: string,
  args?: string,
  options: {
    runtime?: FakeRuntime;
    hasActiveRun?: boolean;
    withoutHost?: boolean;
    cwd?: string;
    rpcCommandNames?: string[];
    readChangelog?: () => Promise<PiChangelog | null>;
  } = {},
): Promise<RunResult> {
  const runtime = options.runtime ?? new FakeRuntime();
  const texts: string[] = [];
  const calls: string[] = [];
  const host: AgentOutOfBandHost = {
    hasActiveRun: () => options.hasActiveRun ?? false,
    setModel: async (modelId) => {
      calls.push(`model:${modelId}`);
    },
    setThinkingOption: async (level) => {
      calls.push(`thinking:${level}`);
    },
    rename: async (title) => {
      calls.push(`rename:${title}`);
    },
    reload: async () => {
      calls.push("reload");
    },
  };
  await runPiBuiltinCommand({
    name,
    ...(args ? { args } : {}),
    runtime,
    host: options.withoutHost ? undefined : host,
    cwd: options.cwd ?? "/w",
    rpcCommandNames: options.rpcCommandNames ?? [],
    ...(options.readChangelog ? { readChangelog: options.readChangelog } : {}),
    say: (text) => texts.push(text),
  });
  return { texts, calls, runtime };
}

describe("resolvePiModelArgument", () => {
  test("matches provider/id, a bare id, a name, or a unique part", () => {
    expect(resolvePiModelArgument("anthropic/claude-opus-5-5", MODELS)).toEqual({
      kind: "match",
      model: MODELS[0],
    });
    expect(resolvePiModelArgument("claude-fable-5-2", MODELS)).toMatchObject({
      kind: "match",
      model: MODELS[1],
    });
    expect(resolvePiModelArgument("Claude Opus 5.5", MODELS)).toMatchObject({
      kind: "match",
      model: MODELS[0],
    });
    expect(resolvePiModelArgument("fable", MODELS)).toMatchObject({
      kind: "match",
      model: MODELS[1],
    });
  });

  test("reports an id two providers share as ambiguous", () => {
    const resolution = resolvePiModelArgument("gpt-5.6-sol", MODELS);
    expect(resolution.kind).toBe("ambiguous");
    expect(resolution.kind === "ambiguous" ? resolution.candidates : []).toHaveLength(2);
  });

  test("suggests near models when nothing matches", () => {
    const resolution = resolvePiModelArgument("anthropic/claude-opus-5-6", MODELS);
    expect(resolution.kind).toBe("none");
    expect(resolution.kind === "none" ? resolution.suggestions[0] : null).toEqual(MODELS[0]);
    expect(resolvePiModelArgument("zzzz", MODELS)).toEqual({ kind: "none", suggestions: [] });
  });
});

describe("runPiBuiltinCommand", () => {
  test("reload restarts through the host when idle", async () => {
    const result = await run("reload");
    expect(result.calls).toEqual(["reload"]);
    expect(result.texts.at(-1)).toBe("다시 읽었습니다.");
  });

  test("reload refuses during a turn", async () => {
    const result = await run("reload", undefined, { hasActiveRun: true });
    expect(result.calls).toEqual([]);
    expect(result.texts[0]).toContain("턴이 진행 중이라");
  });

  test("model without an argument shows the current model", async () => {
    const result = await run("model");
    expect(result.calls).toEqual([]);
    expect(result.texts[0]).toContain("`anthropic/claude-opus-5-5`");
  });

  test("model with an argument switches through the host", async () => {
    const result = await run("model", "fable");
    expect(result.calls).toEqual(["model:anthropic/claude-fable-5-2"]);
  });

  test("model lists candidates instead of guessing", async () => {
    const result = await run("model", "gpt-5.6-sol");
    expect(result.calls).toEqual([]);
    expect(result.texts[0]).toContain("`pi-codex/gpt-5.6-sol`");
    expect(result.texts[0]).toContain("`openrouter/gpt-5.6-sol`");
  });

  test("thinking shows levels, sets a valid one, and rejects others", async () => {
    expect((await run("thinking")).texts[0]).toContain("off, low, medium, high");
    expect((await run("thinking", "Medium")).calls).toEqual(["thinking:medium"]);
    const invalid = await run("thinking", "xhigh");
    expect(invalid.calls).toEqual([]);
    expect(invalid.texts[0]).toContain("'xhigh' 수준이 없습니다");
  });

  test("name renames Pi's session and the agent", async () => {
    const result = await run("name", "재고 동기화");
    expect(result.runtime.requests).toContainEqual({
      type: "set_session_name",
      name: "재고 동기화",
    });
    expect(result.calls).toEqual(["rename:재고 동기화"]);
  });

  test("name without an argument shows the current name", async () => {
    const runtime = new FakeRuntime();
    runtime.state = baseState({ sessionName: "기존 이름" });
    const result = await run("name", undefined, { runtime });
    expect(result.calls).toEqual([]);
    expect(result.texts[0]).toContain("'기존 이름'");
  });

  test("export writes HTML through RPC with a cwd-relative path", async () => {
    const result = await run("export", "out/session.html", { cwd: "/repo" });
    expect(result.runtime.requests).toContainEqual({
      type: "export_html",
      outputPath: "/repo/out/session.html",
    });
    expect(result.texts[0]).toBe("세션을 HTML로 내보냈습니다: `/repo/out/session.html`");
  });

  describe("export to JSONL", () => {
    let dir: string | null = null;
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = null;
    });

    test("copies the session file and never overwrites", async () => {
      dir = await mkdtemp(path.join(tmpdir(), "pi-export-"));
      const sessionFile = path.join(dir, "session.jsonl");
      await writeFile(sessionFile, '{"type":"session"}\n');
      const runtime = new FakeRuntime();
      runtime.state = baseState({ sessionFile });

      const first = await run("export", "copy.jsonl", { runtime, cwd: dir });
      expect(first.texts[0]).toContain("JSONL로 내보냈습니다");
      await expect(readFile(path.join(dir, "copy.jsonl"), "utf8")).resolves.toBe(
        '{"type":"session"}\n',
      );

      const second = await run("export", "copy.jsonl", { runtime, cwd: dir });
      expect(second.texts[0]).toContain("이미 있어 덮어쓰지 않았습니다");
    });
  });

  test("session shows state and stats", async () => {
    const runtime = new FakeRuntime();
    runtime.state = baseState({ sessionFile: "/s/a.jsonl", sessionName: "작업" });
    runtime.stats = {
      tokens: { input: 1200, output: 300, total: 1500 },
      cost: 0.12345,
      contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
    };
    const result = await run("session", undefined, { runtime });
    expect(result.texts[0]).toBe(formatPiSessionInfo(runtime.state, runtime.stats));
    expect(result.texts[0]).toContain("토큰: 입력 1,200, 출력 300, 합계 1,500");
    expect(result.texts[0]).toContain("컨텍스트: 50,000 / 200,000 (25.0%)");
  });

  test("changelog shows the newest section and the file", async () => {
    const result = await run("changelog", undefined, {
      readChangelog: async () => ({
        path: "/pi/CHANGELOG.md",
        text: "# Changelog\n\n## [1.5.2] - 2026-11-10\n\n- new\n\n## [1.5.1] - 2026-11-09\n\n- old\n",
      }),
    });
    expect(result.texts[0]).toBe(
      "## [1.5.2] - 2026-11-10\n\n- new\n\n전체 변경 기록: `/pi/CHANGELOG.md`",
    );
  });

  test("changelog says so when Pi's file is missing", async () => {
    const result = await run("changelog", undefined, { readChangelog: async () => null });
    expect(result.texts[0]).toContain("찾지 못했습니다");
  });

  test("guide-only commands touch nothing", async () => {
    for (const name of ["share", "copy", "settings", "trust", "bug", "resume", "import", "clone"]) {
      const result = await run(name);
      expect(result.calls, name).toEqual([]);
      expect(result.runtime.requests, name).toEqual([]);
      expect(result.texts, name).toHaveLength(1);
    }
  });
});

describe("latestChangelogSection", () => {
  test("caps a long section", () => {
    const section = latestChangelogSection(`## [9] - x\n${"a".repeat(5000)}\n## [8]\n`);
    expect(section?.length).toBeLessThan(3600);
    expect(section?.endsWith("…")).toBe(true);
  });
});
