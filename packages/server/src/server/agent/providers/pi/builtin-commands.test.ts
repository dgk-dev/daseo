import { describe, expect, test } from "vitest";

import {
  PI_BUILTIN_COMMANDS,
  PI_BUILTIN_GUIDES,
  findAccountCommands,
  findPiBuiltinCommand,
  formatBuiltinGuide,
  formatUnknownSlashCommand,
  parseSlashCommandToken,
  suggestSlashCommands,
} from "./builtin-commands.js";

// Pi 1.5.2 `BUILTIN_SLASH_COMMANDS` (dist/core/slash-commands.js). The pi-local doctor compares
// the installed Pi with PI_BUILTIN_COMMANDS on every run; this list pins what was reviewed.
const PI_152_BUILTINS = [
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
];

describe("Pi built-in command table", () => {
  test("covers every Pi 1.5.2 built-in plus Daseo's autocompact", () => {
    const names = PI_BUILTIN_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...PI_152_BUILTINS, "autocompact"].sort());
  });

  test("handling per command", () => {
    const handling = Object.fromEntries(
      PI_BUILTIN_COMMANDS.map((command) => [command.name, command.handling]),
    );
    expect(handling).toEqual({
      compact: "run",
      autocompact: "run",
      reload: "run",
      model: "run",
      thinking: "run",
      name: "run",
      export: "run",
      session: "info",
      changelog: "info",
      hotkeys: "info",
      new: "guide",
      quit: "guide",
      tree: "guide",
      fork: "guide",
      clone: "guide",
      resume: "guide",
      import: "guide",
      copy: "guide",
      share: "guide",
      settings: "guide",
      "scoped-models": "guide",
      login: "guide",
      logout: "guide",
      trust: "guide",
      bug: "guide",
    });
  });

  test("every guide-only command has its own guide text", () => {
    for (const command of PI_BUILTIN_COMMANDS.filter((entry) => entry.handling === "guide")) {
      expect(PI_BUILTIN_GUIDES[command.name], command.name).toBeTruthy();
    }
  });

  test("finds built-ins case-insensitively", () => {
    expect(findPiBuiltinCommand("Reload")?.name).toBe("reload");
    expect(findPiBuiltinCommand("review")).toBeNull();
  });
});

describe("parseSlashCommandToken", () => {
  test("reads a command name and its arguments", () => {
    expect(parseSlashCommandToken("/reload")).toEqual({ name: "reload" });
    expect(parseSlashCommandToken("  /model  anthropic/claude  ")).toEqual({
      name: "model",
      args: "anthropic/claude",
    });
    expect(parseSlashCommandToken("/skill:docs read this")).toEqual({
      name: "skill:docs",
      args: "read this",
    });
    expect(parseSlashCommandToken("/name 재고\n동기화")).toEqual({
      name: "name",
      args: "재고\n동기화",
    });
  });

  test("leaves paths and ordinary text alone", () => {
    for (const text of [
      "/Users/ddgk/a.txt",
      "/tmp/x 봐줘",
      "/tmp/",
      "/폴더 봐줘",
      "/",
      "/ reload",
      "/1password",
      "hello /reload",
    ]) {
      expect(parseSlashCommandToken(text), text).toBeNull();
    }
  });
});

describe("unknown command answers", () => {
  test("suggests near names, prefix matches first", () => {
    const known = ["reload", "review", "resume", "model", "skill:docs"];
    expect(suggestSlashCommands("relaod", known)).toEqual(["reload"]);
    expect(suggestSlashCommands("re", known)).toEqual(["reload", "resume", "review"]);
    expect(suggestSlashCommands("docs", known)).toEqual(["skill:docs"]);
    expect(suggestSlashCommands("zzzz", known)).toEqual([]);
  });

  test("says the prompt was not sent and lists suggestions", () => {
    expect(formatUnknownSlashCommand("relaod", ["reload"])).toBe(
      [
        "/relaod 명령은 없습니다. 모델에게 보내지 않았습니다.",
        "비슷한 명령: /reload",
        "명령 목록은 입력창에 /를 치면 나옵니다. 글을 보내려면 앞에 공백을 넣으세요.",
      ].join("\n"),
    );
  });
});

describe("login guide", () => {
  test("names this environment's account commands", () => {
    expect(findAccountCommands(["review", "claude-auth", "codex-login", "account"])).toEqual([
      "account",
      "claude-auth",
      "codex-login",
    ]);
    expect(formatBuiltinGuide("login", ["claude-auth"])).toContain(
      "이 환경의 계정 명령: /claude-auth",
    );
    expect(formatBuiltinGuide("trust", ["claude-auth"])).not.toContain("/claude-auth");
  });
});
