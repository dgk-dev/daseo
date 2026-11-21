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
}

export interface LoginBannerPair {
  label: string;
  value: string;
}

export interface LoginBannerModel {
  welcome: string;
  pairs: LoginBannerPair[];
  lastLogin: string | null;
}

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
    lastLogin: formatLastLogin(facts.lastLogin),
  };
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
 * The banner as text lines. `columns` is how many label/value pairs share a line: two on a wide
 * pane, one on a phone so a pair never overflows. Labels and values pad to their column so the
 * values line up in a monospace font.
 */
export function layoutLoginBanner(model: LoginBannerModel, columns: 1 | 2): string[] {
  const lines = [model.welcome];
  if (model.pairs.length > 0) {
    lines.push("");
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
      lines.push(`  ${cells.join("   ")}`.trimEnd());
    }
  }
  if (model.lastLogin) {
    lines.push("", model.lastLogin);
  }
  return lines;
}
