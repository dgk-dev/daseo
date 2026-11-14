import { constants as fsConstants } from "node:fs";
import { access, copyFile, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentOutOfBandHost } from "../../agent-sdk-types.js";
import {
  PI_HOTKEYS_TEXT,
  findAccountCommands,
  formatBuiltinGuide,
  suggestSlashCommands,
} from "./builtin-commands.js";
import type { PiModel, PiSessionState, PiSessionStats } from "./rpc-types.js";

/** The Pi RPC calls the built-in commands use. */
export interface PiBuiltinRuntime {
  getState(): Promise<PiSessionState>;
  getSessionStats(): Promise<PiSessionStats>;
  getAvailableModels(): Promise<PiModel[]>;
  request(command: { type: string; [key: string]: unknown }): Promise<unknown>;
}

export interface PiChangelog {
  path: string;
  text: string;
}

export interface PiBuiltinCommandInput {
  /** Lower-case built-in name from `PI_BUILTIN_COMMANDS` (not compact or autocompact). */
  name: string;
  args?: string;
  runtime: PiBuiltinRuntime;
  host: AgentOutOfBandHost | undefined;
  cwd: string;
  /** Names Pi's RPC lists (extensions, prompt templates, skills). */
  rpcCommandNames: readonly string[];
  readChangelog?: () => Promise<PiChangelog | null>;
  say(text: string): void;
}

const CHANGELOG_DISPLAY_LIMIT = 3_500;
const MODEL_LIST_LIMIT = 8;

export async function runPiBuiltinCommand(input: PiBuiltinCommandInput): Promise<void> {
  switch (input.name) {
    case "reload":
      return runReload(input);
    case "model":
      return runModel(input);
    case "thinking":
      return runThinking(input);
    case "name":
      return runName(input);
    case "export":
      return runExport(input);
    case "session":
      return runSession(input);
    case "changelog":
      return runChangelog(input);
    case "hotkeys":
      input.say(PI_HOTKEYS_TEXT);
      return;
    default:
      input.say(formatBuiltinGuide(input.name, findAccountCommands(input.rpcCommandNames)));
  }
}

async function runReload(input: PiBuiltinCommandInput): Promise<void> {
  const { host } = input;
  if (!host) {
    input.say(
      "이 경로에서는 Pi를 다시 시작할 수 없습니다. 탭 메뉴의 에이전트 다시 불러오기를 쓰세요.",
    );
    return;
  }
  if (host.hasActiveRun()) {
    input.say(
      "턴이 진행 중이라 다시 읽지 않았습니다. 턴이 끝난 뒤 /reload를 다시 보내거나, 먼저 멈추세요.",
    );
    return;
  }
  input.say("Pi를 같은 세션으로 다시 시작해 확장, 스킬, 프롬프트, 컨텍스트 파일을 다시 읽습니다.");
  await host.reload();
  input.say("다시 읽었습니다.");
}

export type PiModelResolution =
  | { kind: "match"; model: PiModel }
  | { kind: "ambiguous"; candidates: PiModel[] }
  | { kind: "none"; suggestions: PiModel[] };

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

function uniqueMatch(models: PiModel[]): PiModelResolution | null {
  if (models.length === 1) return { kind: "match", model: models[0]! };
  if (models.length > 1) return { kind: "ambiguous", candidates: models };
  return null;
}

/** `provider/id`, a bare id, a display name, or a unique part of one, case-insensitive. */
export function resolvePiModelArgument(argument: string, models: PiModel[]): PiModelResolution {
  const query = argument.trim().toLowerCase();
  const byExactKey = uniqueMatch(models.filter((model) => modelKey(model).toLowerCase() === query));
  if (byExactKey) return byExactKey;
  const byId = uniqueMatch(models.filter((model) => model.id.toLowerCase() === query));
  if (byId) return byId;
  const byName = uniqueMatch(models.filter((model) => model.name?.toLowerCase() === query));
  if (byName) return byName;
  const partial = models.filter(
    (model) =>
      modelKey(model).toLowerCase().includes(query) ||
      (model.name?.toLowerCase().includes(query) ?? false),
  );
  const byPart = uniqueMatch(partial);
  if (byPart) return byPart;
  const byKey = new Map(models.map((model) => [modelKey(model), model]));
  const close = suggestSlashCommands(query, [...byKey.keys()], MODEL_LIST_LIMIT);
  return { kind: "none", suggestions: close.flatMap((key) => byKey.get(key) ?? []) };
}

function formatModelList(models: PiModel[]): string {
  const shown = models.slice(0, MODEL_LIST_LIMIT).map((model) => `\`${modelKey(model)}\``);
  const more = models.length > MODEL_LIST_LIMIT ? ` 외 ${models.length - MODEL_LIST_LIMIT}개` : "";
  return `${shown.join(", ")}${more}`;
}

async function runModel(input: PiBuiltinCommandInput): Promise<void> {
  const state = await input.runtime.getState();
  const current = state.model ? modelKey(state.model) : "알 수 없음";
  if (!input.args) {
    input.say(
      `지금 모델: \`${current}\`\n바꾸려면 입력창의 모델 선택을 쓰거나 /model <provider/model>을 보내세요.`,
    );
    return;
  }
  const models = await input.runtime.getAvailableModels();
  const resolution = resolvePiModelArgument(input.args, models);
  if (resolution.kind === "ambiguous") {
    input.say(
      `'${input.args}'에 맞는 모델이 여럿입니다: ${formatModelList(resolution.candidates)}\n하나를 골라 /model <provider/model>로 보내세요.`,
    );
    return;
  }
  if (resolution.kind === "none") {
    const hint =
      resolution.suggestions.length > 0
        ? `\n비슷한 모델: ${formatModelList(resolution.suggestions)}`
        : "";
    input.say(`'${input.args}' 모델을 찾지 못했습니다. 지금 모델은 \`${current}\`입니다.${hint}`);
    return;
  }
  if (!input.host) {
    input.say("이 경로에서는 모델을 바꿀 수 없습니다. 입력창의 모델 선택을 쓰세요.");
    return;
  }
  const target = modelKey(resolution.model);
  await input.host.setModel(target);
  input.say(`모델을 \`${target}\`(으)로 바꿨습니다.`);
}

async function runThinking(input: PiBuiltinCommandInput): Promise<void> {
  const state = await input.runtime.getState();
  const data = (await input.runtime.request({ type: "get_available_thinking_levels" })) as {
    levels?: unknown;
  } | null;
  const levels = Array.isArray(data?.levels)
    ? data.levels.filter((level): level is string => typeof level === "string")
    : [];
  const levelList = levels.length > 0 ? levels.join(", ") : "알 수 없음";
  if (!input.args) {
    input.say(
      `지금 생각 수준: ${state.thinkingLevel}\n고를 수 있는 수준: ${levelList}\n바꾸려면 /thinking <수준>을 보내세요.`,
    );
    return;
  }
  const level = input.args.trim().toLowerCase();
  if (!levels.includes(level)) {
    input.say(`이 모델에는 '${input.args}' 수준이 없습니다. 고를 수 있는 수준: ${levelList}`);
    return;
  }
  if (!input.host) {
    input.say("이 경로에서는 생각 수준을 바꿀 수 없습니다. 입력창의 생각 수준 선택을 쓰세요.");
    return;
  }
  await input.host.setThinkingOption(level);
  input.say(`생각 수준을 ${level}(으)로 바꿨습니다.`);
}

async function runName(input: PiBuiltinCommandInput): Promise<void> {
  const title = input.args?.trim();
  if (!title) {
    const state = await input.runtime.getState();
    const current = state.sessionName ? `'${state.sessionName}'` : "없음";
    input.say(`지금 Pi 세션 이름: ${current}\n바꾸려면 /name <이름>을 보내세요.`);
    return;
  }
  await input.runtime.request({ type: "set_session_name", name: title });
  await input.host?.rename(title);
  input.say(`이름을 '${title}'(으)로 바꿨습니다. 자동 이름은 이 이름을 덮어쓰지 않습니다.`);
}

function resolveUserPath(cwd: string, target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/")) return path.join(os.homedir(), target.slice(2));
  return path.resolve(cwd, target);
}

async function runExport(input: PiBuiltinCommandInput): Promise<void> {
  const target = input.args ? resolveUserPath(input.cwd, input.args) : null;
  if (target?.toLowerCase().endsWith(".jsonl")) {
    const state = await input.runtime.getState();
    if (!state.sessionFile) {
      input.say("이 세션에는 세션 파일이 없어 JSONL로 내보낼 수 없습니다.");
      return;
    }
    try {
      await copyFile(state.sessionFile, target, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      input.say(
        code === "EEXIST"
          ? `\`${target}\` 파일이 이미 있어 덮어쓰지 않았습니다. 다른 경로를 주세요.`
          : `JSONL로 내보내지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    input.say(`세션을 JSONL로 내보냈습니다: \`${target}\``);
    return;
  }
  const data = (await input.runtime.request({
    type: "export_html",
    ...(target ? { outputPath: target } : {}),
  })) as { path?: unknown } | null;
  const written = typeof data?.path === "string" ? data.path : target;
  input.say(written ? `세션을 HTML로 내보냈습니다: \`${written}\`` : "세션을 HTML로 내보냈습니다.");
}

function formatNumber(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : null;
}

export function formatPiSessionInfo(state: PiSessionState, stats: PiSessionStats): string {
  const lines = [`세션 이름: ${state.sessionName ?? "없음"}`];
  if (state.sessionFile) lines.push(`세션 파일: \`${state.sessionFile}\``);
  lines.push(`세션 ID: ${state.sessionId}`);
  if (state.model)
    lines.push(`모델: \`${modelKey(state.model)}\`, 생각 수준: ${state.thinkingLevel}`);
  lines.push(`메시지: ${state.messageCount}개`);
  const tokens = stats.tokens;
  if (tokens) {
    const parts = [
      ["입력", tokens.input],
      ["출력", tokens.output],
      ["캐시 읽기", tokens.cacheRead],
      ["캐시 쓰기", tokens.cacheWrite],
      ["합계", tokens.total],
    ]
      .map(([label, value]) => {
        const formatted = formatNumber(value as number | undefined);
        return formatted ? `${label} ${formatted}` : null;
      })
      .filter((part): part is string => part !== null);
    if (parts.length > 0) lines.push(`토큰: ${parts.join(", ")}`);
  }
  if (typeof stats.cost === "number") lines.push(`비용: $${stats.cost.toFixed(4)}`);
  const usage = stats.contextUsage ?? state.contextUsage;
  const used = formatNumber(usage?.tokens);
  const window = formatNumber(usage?.contextWindow);
  if (used && window) {
    const percent = typeof usage?.percent === "number" ? ` (${usage.percent.toFixed(1)}%)` : "";
    lines.push(`컨텍스트: ${used} / ${window}${percent}`);
  }
  if (state.autoCompactionEnabled !== undefined) {
    lines.push(`자동 압축: ${state.autoCompactionEnabled ? "켜짐" : "꺼짐"}`);
  }
  return lines.join("\n");
}

async function runSession(input: PiBuiltinCommandInput): Promise<void> {
  const [state, stats] = await Promise.all([
    input.runtime.getState(),
    input.runtime.getSessionStats(),
  ]);
  input.say(formatPiSessionInfo(state, stats));
}

/** The newest version section of a Pi CHANGELOG.md, capped for the timeline. */
export function latestChangelogSection(markdown: string): string | null {
  const latest = markdown
    .split(/^(?=## )/m)
    .find((section) => section.startsWith("## "))
    ?.trim();
  if (!latest) return null;
  if (latest.length <= CHANGELOG_DISPLAY_LIMIT) return latest;
  return `${latest.slice(0, CHANGELOG_DISPLAY_LIMIT).trimEnd()}\n…`;
}

async function runChangelog(input: PiBuiltinCommandInput): Promise<void> {
  const changelog = await (input.readChangelog ?? readInstalledPiChangelog)();
  const section = changelog ? latestChangelogSection(changelog.text) : null;
  if (!changelog || !section) {
    input.say(
      "설치된 Pi의 변경 기록을 찾지 못했습니다. 맥 터미널에서 `pi --version`으로 버전을 보세요.",
    );
    return;
  }
  input.say(`${section}\n\n전체 변경 기록: \`${changelog.path}\``);
}

async function findOnPath(command: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

/** Find CHANGELOG.md next to the `pi` on PATH, which is the binary Daseo launches. */
export async function readInstalledPiChangelog(): Promise<PiChangelog | null> {
  const binary = await findOnPath("pi");
  if (!binary) return null;
  let dir = path.dirname(await realpath(binary));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (typeof manifest.name === "string" && manifest.name.endsWith("pi-coding-agent")) {
        const changelogPath = path.join(dir, "CHANGELOG.md");
        return { path: changelogPath, text: await readFile(changelogPath, "utf8") };
      }
    } catch {
      // no package.json here, keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
