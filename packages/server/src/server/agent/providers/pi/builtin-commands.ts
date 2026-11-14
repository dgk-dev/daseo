/**
 * Local fork (DASEO.md delta 109): every Pi built-in slash command answers in Daseo.
 *
 * Pi's interactive mode handles its built-in commands itself; RPC `get_commands` lists only
 * extension, prompt-template, and skill commands, so before this table a typed `/reload` reached
 * the model as prompt text and cost a turn. Each built-in now either runs (`run`), shows
 * information in the timeline (`info`), or says where Daseo does it (`guide`). The client
 * intercepts `/new` and `/quit` before sending (aliases of `/clear` and `/exit`), so the server
 * only sees them with arguments.
 *
 * This file has no runtime imports on purpose: `~/ws/pi-local` doctor imports it with Node type
 * stripping and compares `PI_BUILTIN_COMMANDS` with the installed Pi's `BUILTIN_SLASH_COMMANDS`,
 * so a Pi upgrade that adds a built-in is reported before anyone types it.
 */

export type PiBuiltinCommandHandling = "run" | "info" | "guide";

export interface PiBuiltinCommand {
  name: string;
  /** Shown in autocomplete. Pi's own wording unless Daseo does something different. */
  description: string;
  argumentHint: string;
  handling: PiBuiltinCommandHandling;
}

export const PI_BUILTIN_COMMANDS: readonly PiBuiltinCommand[] = [
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "[instructions]",
    handling: "run",
  },
  {
    name: "autocompact",
    description: "Toggle automatic context compaction",
    argumentHint: "[on|off|toggle]",
    handling: "run",
  },
  {
    name: "reload",
    description: "Restart Pi to reload extensions, skills, prompts, and context files",
    argumentHint: "",
    handling: "run",
  },
  {
    name: "model",
    description: "Switch model, or show the current one",
    argumentHint: "[provider/model]",
    handling: "run",
  },
  {
    name: "thinking",
    description: "Set thinking level, or show the levels",
    argumentHint: "[level]",
    handling: "run",
  },
  {
    name: "name",
    description: "Set session display name",
    argumentHint: "<name>",
    handling: "run",
  },
  {
    name: "export",
    description: "Export session (HTML default, or specify path: .html/.jsonl)",
    argumentHint: "[path]",
    handling: "run",
  },
  {
    name: "session",
    description: "Show session info and stats",
    argumentHint: "",
    handling: "info",
  },
  {
    name: "changelog",
    description: "Show changelog entries",
    argumentHint: "",
    handling: "info",
  },
  {
    name: "hotkeys",
    description: "Show where Daseo keyboard shortcuts are listed",
    argumentHint: "",
    handling: "info",
  },
  {
    name: "new",
    description: "Archive this agent and start a fresh draft (same as /clear)",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "quit",
    description: "Archive the current agent (same as /exit)",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "tree",
    description: "Navigate session tree (in Daseo: rewind from a message)",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "fork",
    description: "Create a new fork from a previous user message (in Daseo: rewind)",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "clone",
    description: "Duplicate the current session at the current position",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "resume",
    description: "Resume another session (in Daseo: Import session)",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "import",
    description: "Import a JSONL session (in Daseo: Import session)",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "copy",
    description: "Copy last agent message to clipboard (in Daseo: the message's copy button)",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "share",
    description: "Share session via a Radius artifact or a GitHub gist",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "settings",
    description: "Open settings menu",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "scoped-models",
    description: "Enable/disable models for Ctrl+P cycling",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "login",
    description: "Configure provider authentication",
    argumentHint: "<provider>",
    handling: "guide",
  },
  {
    name: "logout",
    description: "Remove provider authentication",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "trust",
    description: "Save project trust decision for future sessions",
    argumentHint: "",
    handling: "guide",
  },
  {
    name: "bug",
    description: "Report a bug to the Pi developers",
    argumentHint: "<description>",
    handling: "guide",
  },
];

const BUILTIN_BY_NAME = new Map(PI_BUILTIN_COMMANDS.map((command) => [command.name, command]));

export function findPiBuiltinCommand(name: string): PiBuiltinCommand | null {
  return BUILTIN_BY_NAME.get(name.toLowerCase()) ?? null;
}

export interface SlashCommandToken {
  name: string;
  args?: string;
}

/**
 * A command candidate is `/name` at the start, where the name starts with a letter and holds only
 * letters, digits, `_`, `:`, `.`, or `-`, followed by whitespace or the end. `/Users/me/a.txt`,
 * `/tmp/x 봐줘`, and `/` followed by Korean are ordinary text and go to the model.
 */
const SLASH_COMMAND_PATTERN = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/;

export function parseSlashCommandToken(text: string): SlashCommandToken | null {
  const match = SLASH_COMMAND_PATTERN.exec(text.trim());
  if (!match) {
    return null;
  }
  const name = match[1]!;
  const args = match[2]?.trim();
  return args ? { name, args } : { name };
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, previous[j - 1]! + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

/** Up to `limit` known names close to `name`: prefix matches first, then by edit distance. */
export function suggestSlashCommands(
  name: string,
  knownNames: readonly string[],
  limit = 3,
): string[] {
  const target = name.toLowerCase();
  const maxDistance = Math.max(1, Math.floor(target.length / 3));
  const scored: Array<{ name: string; score: number }> = [];
  for (const candidate of new Set(knownNames)) {
    const lower = candidate.toLowerCase();
    if (lower === target) continue;
    if (lower.startsWith(target) || (target.length >= 3 && lower.includes(target))) {
      scored.push({ name: candidate, score: lower.startsWith(target) ? 0 : 0.5 });
      continue;
    }
    const distance = editDistance(target, lower);
    if (distance <= maxDistance) {
      scored.push({ name: candidate, score: distance });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((entry) => entry.name);
}

export function formatUnknownSlashCommand(name: string, suggestions: readonly string[]): string {
  const lines = [`/${name} 명령은 없습니다. 모델에게 보내지 않았습니다.`];
  if (suggestions.length > 0) {
    lines.push(`비슷한 명령: ${suggestions.map((suggestion) => `/${suggestion}`).join(", ")}`);
  }
  lines.push("명령 목록은 입력창에 /를 치면 나옵니다. 글을 보내려면 앞에 공백을 넣으세요.");
  return lines.join("\n");
}

/** What a `guide` built-in says, by name. `login`/`logout` add the account commands they find. */
export const PI_BUILTIN_GUIDES: Readonly<Record<string, string>> = {
  new: "Daseo에서는 /new를 인자 없이 치면 이 에이전트를 보관하고 새 초안을 엽니다(/clear와 같음).",
  quit: "Daseo에서는 /quit을 인자 없이 치면 이 에이전트를 보관합니다(/exit와 같음).",
  tree: "Daseo에서는 세션 트리 대신 되돌아갈 내 메시지 옆의 '이 메시지로 되감기'를 씁니다. 대화, 파일, 둘 다 중에서 고를 수 있습니다.",
  fork: "Daseo에서는 갈라질 지점의 내 메시지 옆 '이 메시지로 되감기'를 씁니다. Pi의 /fork는 세션 파일을 바꿔치기해 Daseo 기록과 어긋나므로 실행하지 않습니다.",
  clone:
    "Daseo에는 세션 복제가 없습니다. 같은 설정으로 새로 시작하려면 /new, 지금 대화를 파일로 남기려면 /export를 쓰세요.",
  resume: "Daseo에서는 작업공간 머리글의 ⋯ 메뉴에서 '세션 가져오기'로 다른 Pi 세션을 엽니다.",
  import:
    "Daseo에서는 작업공간 머리글의 ⋯ 메뉴에서 '세션 가져오기'를 씁니다. 세션 파일을 바꿔치기하는 Pi의 /import는 실행하지 않습니다.",
  copy: "Daseo에서는 응답 옆의 '메시지 복사' 버튼으로 복사합니다(서버는 이 기기의 클립보드에 쓸 수 없습니다).",
  share:
    "공유는 세션을 외부(gist 또는 Radius)에 올리는 일이라 Daseo에서는 실행하지 않습니다. /export로 HTML을 만든 뒤 직접 올리세요.",
  settings:
    "Daseo 설정은 앱의 설정 화면에서 바꿉니다. Pi 설정은 `~/.pi/agent/settings.json` 파일에 있고, 바꾼 뒤 /reload로 다시 읽습니다.",
  "scoped-models":
    "Daseo의 모델 목록은 Pi 설정 `~/.pi/agent/settings.json`의 enabledModels를 따릅니다. 모델 전환은 입력창의 모델 선택이나 /model <이름>으로 합니다.",
  login:
    "Daseo에서는 Pi 로그인 창을 열 수 없습니다. 맥 터미널에서 `pi auth login <provider>`를 실행하세요.",
  logout:
    "Daseo에서는 Pi 로그아웃 창을 열 수 없습니다. 맥 터미널에서 `pi auth logout <provider>`를 실행하세요.",
  trust:
    "Daseo가 띄우는 Pi는 저장된 신뢰 설정을 따릅니다. 신뢰 결정을 저장하려면 맥 터미널에서 이 폴더로 `pi`를 열고 /trust를 실행하세요.",
  bug: "Pi 버그 신고는 맥 터미널의 `pi`에서 /bug로 합니다. Daseo 문제는 도움말 및 지원의 '문제 신고'를 쓰세요.",
};

/** Extension commands that manage accounts, named in the login and logout guides. */
export function findAccountCommands(commandNames: readonly string[]): string[] {
  return commandNames.filter((name) => /(auth|login|logout|account)/i.test(name)).sort();
}

export function formatBuiltinGuide(name: string, accountCommands: readonly string[] = []): string {
  const guide = PI_BUILTIN_GUIDES[name] ?? `Daseo에서는 /${name}을 실행하지 않습니다.`;
  if ((name === "login" || name === "logout") && accountCommands.length > 0) {
    return `${guide}\n이 환경의 계정 명령: ${accountCommands.map((command) => `/${command}`).join(", ")}`;
  }
  return guide;
}

export const PI_HOTKEYS_TEXT =
  "Daseo 단축키 목록은 입력창 밖에서 ?를 누르거나, 도움말 및 지원의 '키보드 단축키'에서 봅니다. 설정에서 바꿀 수 있고, 폰 앱에는 단축키가 없습니다.";
