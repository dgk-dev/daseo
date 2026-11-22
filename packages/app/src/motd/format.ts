/**
 * Daseo: the login banner an empty chat shows, in the shape of Ubuntu's MOTD. Only measured
 * values appear: a fact the daemon did not send is left out together with its label.
 */
export interface LoginBannerFacts {
  os?: { type: string; release: string; arch: string };
  loadAverage1m?: number;
  agentsRunning?: number;
  memory?: { usedBytes: number; totalBytes: number };
  swap?: { usedBytes: number };
  lastLogin?: { at: number; from?: string };
  /** Daseo delta 144 */
  disk?: { usedBytes: number; totalBytes: number };
  extraHeaders?: LoginBannerPair[];
  /** `warning` or `critical`; a level this app does not know reads as a warning. */
  notes?: Array<{ severity: string; text: string }>;
  restartRequired?: { version: string };
}

export interface LoginBannerPair {
  label: string;
  value: string;
}

export interface LoginBannerNote {
  severity: "warning" | "critical";
  text: string;
}

export interface LoginBannerModel {
  welcome: string;
  pairs: LoginBannerPair[];
  /** Critical first, then the daemon's order; at most six, each at most 120 characters. */
  notes: LoginBannerNote[];
  restartRequired: string | null;
  lastLogin: string | null;
}

/**
 * How a line is coloured: the banner is muted, a warning note one step brighter (the normal
 * foreground), a critical note the destructive red the tool rows use for a failed exit, and the
 * restart line the normal foreground.
 */
export type LoginBannerTone = "muted" | "warning" | "critical" | "notice";

export interface LoginBannerLine {
  /** Stable within one banner: the line's role, plus its position among pairs or notes. */
  key: string;
  text: string;
  tone: LoginBannerTone;
}

const MAX_NOTES = 6;
const MAX_NOTE_LENGTH = 120;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function buildLoginBanner(input: {
  appVersion: string | null;
  facts: LoginBannerFacts | null;
}): LoginBannerModel {
  const facts = input.facts ?? {};
  const pairs: LoginBannerPair[] = [];
  if (isCount(facts.loadAverage1m)) {
    pairs.push({ label: "System load:", value: facts.loadAverage1m.toFixed(2) });
  }
  if (isCount(facts.agentsRunning)) {
    pairs.push({ label: "Agents running:", value: String(Math.floor(facts.agentsRunning)) });
  }
  const disk = formatDiskUsage(facts.disk);
  if (disk) {
    pairs.push({ label: "Usage of /:", value: disk });
  }
  for (const header of facts.extraHeaders ?? []) {
    pairs.push({ label: header.label, value: header.value });
  }
  const memory = formatMemoryUsage(facts.memory);
  if (memory) {
    pairs.push({ label: "Memory usage:", value: memory });
  }
  if (facts.swap && isCount(facts.swap.usedBytes)) {
    pairs.push({ label: "Swap usage:", value: formatBytes(facts.swap.usedBytes) });
  }
  return {
    welcome: formatWelcome(input.appVersion, facts.os),
    pairs,
    notes: orderNotes(facts.notes ?? []),
    restartRequired: facts.restartRequired?.version.trim() || null,
    lastLogin: formatLastLogin(facts.lastLogin),
  };
}

function orderNotes(notes: NonNullable<LoginBannerFacts["notes"]>): LoginBannerNote[] {
  const shown: LoginBannerNote[] = notes
    .filter((note) => note.text.trim().length > 0)
    .map((note) => ({
      severity: note.severity === "critical" ? "critical" : "warning",
      text: cutNote(note.text.trim()),
    }));
  // Array.prototype.sort is stable, so each severity keeps the daemon's order.
  shown.sort((left, right) => severityRank(left) - severityRank(right));
  return shown.slice(0, MAX_NOTES);
}

function severityRank(note: LoginBannerNote): number {
  return note.severity === "critical" ? 0 : 1;
}

function cutNote(text: string): string {
  return text.length > MAX_NOTE_LENGTH ? `${text.slice(0, MAX_NOTE_LENGTH - 1)}…` : text;
}

/** Ubuntu's `73.0% of 460GB`: one decimal always, as landscape-sysinfo prints it. */
function formatDiskUsage(disk: LoginBannerFacts["disk"]): string | null {
  if (!disk || !isCount(disk.usedBytes) || !(disk.totalBytes > 0)) return null;
  if (disk.usedBytes > disk.totalBytes) return null;
  return `${((disk.usedBytes / disk.totalBytes) * 100).toFixed(1)}% of ${formatBytes(disk.totalBytes)}`;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function formatWelcome(appVersion: string | null, os: LoginBannerFacts["os"]): string {
  const name = appVersion ? `Welcome to Daseo ${appVersion}` : "Welcome to Daseo";
  const host = os ? [os.type, os.release, os.arch].filter(Boolean).join(" ") : "";
  return host ? `${name} (${host})` : name;
}

function formatMemoryUsage(memory: LoginBannerFacts["memory"]): string | null {
  if (!memory || !isCount(memory.usedBytes) || !(memory.totalBytes > 0)) return null;
  if (memory.usedBytes > memory.totalBytes) return null;
  const percent = Math.round((memory.usedBytes / memory.totalBytes) * 100);
  return `${percent}% of ${formatBytes(memory.totalBytes)}`;
}

/** `32GB`, `4.2GB`, `512MB`: one decimal only when it says something. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${trimDecimal(bytes / GIB)}GB`;
  return `${Math.round(bytes / MIB)}MB`;
}

function trimDecimal(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/** `Sat Nov 21 14:02:11 2026 from fold7`, in the reader's own time zone. */
function formatLastLogin(lastLogin: LoginBannerFacts["lastLogin"]): string | null {
  if (!lastLogin || !Number.isFinite(lastLogin.at) || lastLogin.at <= 0) return null;
  const date = new Date(lastLogin.at);
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()} ${two(
    date.getHours(),
  )}:${two(date.getMinutes())}:${two(date.getSeconds())} ${date.getFullYear()}`;
  const from = lastLogin.from?.trim();
  return from ? `Last login: ${stamp} from ${from}` : `Last login: ${stamp}`;
}

/**
 * The banner as lines. `columns` is how many label/value pairs share a line: two on a wide pane,
 * one on a phone so a pair never overflows. Labels and values pad to their column so the values
 * line up in a monospace font. Notes are not padded; on a phone they wrap.
 */
export function layoutLoginBanner(model: LoginBannerModel, columns: 1 | 2): LoginBannerLine[] {
  const lines: LoginBannerLine[] = [muted("welcome", model.welcome)];
  if (model.pairs.length > 0) {
    lines.push(muted("pairs-gap", ""));
    const labelWidths: number[] = [];
    const valueWidths: number[] = [];
    model.pairs.forEach((pair, index) => {
      const column = index % columns;
      labelWidths[column] = Math.max(labelWidths[column] ?? 0, pair.label.length);
      valueWidths[column] = Math.max(valueWidths[column] ?? 0, pair.value.length);
    });
    for (let index = 0; index < model.pairs.length; index += columns) {
      const cells = model.pairs.slice(index, index + columns).map((pair, column) => {
        const cell = `${pair.label.padEnd(labelWidths[column] ?? 0)} ${pair.value}`;
        return cell.padEnd((labelWidths[column] ?? 0) + 1 + (valueWidths[column] ?? 0));
      });
      lines.push(muted(`pairs-${index}`, `  ${cells.join("   ")}`.trimEnd()));
    }
  }
  if (model.notes.length > 0) {
    lines.push(muted("notes-gap", ""));
    model.notes.forEach((note, index) => {
      lines.push({ key: `note-${index}`, text: `=> ${note.text}`, tone: note.severity });
    });
  }
  if (model.restartRequired) {
    lines.push(muted("restart-gap", ""), {
      key: "restart",
      text: `*** Daseo ${model.restartRequired} is installed; restart required ***`,
      tone: "notice",
    });
  }
  if (model.lastLogin) {
    lines.push(muted("last-login-gap", ""), muted("last-login", model.lastLogin));
  }
  return lines;
}

function muted(key: string, text: string): LoginBannerLine {
  return { key, text, tone: "muted" };
}
