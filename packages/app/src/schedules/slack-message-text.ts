/**
 * Daseo delta 135 (2026-11-23): a scheduled Slack message as the owner reads and edits it. Slack
 * stores markup on the wire (`<@U123>`, `<#C1|ax>`, `<https://x|label>`, `&amp;`); the Schedules
 * screen shows it the way Slack would (`@도영`, `#ax`, `label`, `&`) without rendering bold or
 * italics, and the text editor shows mentions as `@이름` and turns them back into `<@U…>` on save.
 * Pure functions only; names come from the entry's own `mentions` (user id -> name).
 */

export type SlackMentionNames = Readonly<Record<string, string>> | null | undefined;

export interface SlackTextSegment {
  /** "mention": a person, group, channel, or @here; "link": a link's label or address. */
  kind: "text" | "mention" | "link";
  text: string;
}

const TOKEN = /<([^<>\n]+)>/g;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BROADCASTS = new Set(["here", "channel", "everyone"]);

function decodeEntities(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function splitLabel(inner: string): { target: string; label: string | null } {
  const bar = inner.indexOf("|");
  if (bar < 0) return { target: inner, label: null };
  const label = inner.slice(bar + 1);
  return { target: inner.slice(0, bar), label: label.length > 0 ? label : null };
}

function withAt(value: string): string {
  return value.startsWith("@") ? value : `@${value}`;
}

/** One `<…>` token as the reader sees it; null leaves the token as typed. */
function readToken(inner: string, mentions: SlackMentionNames): SlackTextSegment | null {
  const { target, label } = splitLabel(inner);
  if (target.startsWith("@")) {
    const name = mentions?.[target.slice(1)]?.trim();
    if (name) return { kind: "mention", text: `@${name}` };
    return label ? { kind: "mention", text: withAt(decodeEntities(label)) } : null;
  }
  if (target.startsWith("#")) {
    return label ? { kind: "mention", text: `#${decodeEntities(label)}` } : null;
  }
  if (target.startsWith("!")) {
    const command = target.slice(1);
    if (BROADCASTS.has(command)) return { kind: "mention", text: `@${command}` };
    if (command.startsWith("subteam^")) {
      return label ? { kind: "mention", text: withAt(decodeEntities(label)) } : null;
    }
    if (command.startsWith("date^")) {
      return label ? { kind: "text", text: decodeEntities(label) } : null;
    }
    return null;
  }
  if (URL_SCHEME.test(target)) {
    return { kind: "link", text: decodeEntities(label ?? target) };
  }
  return null;
}

/**
 * Slack's wire text as display segments: mentions as `@이름` from `mentions` (an unknown id stays as
 * typed), `<#C…|name>` as `#name`, `<!here>` as `@here`, `<!subteam^…|@handle>` as `@handle`,
 * `<url|label>` as `label`, `<url>` as `url`, and `&amp; &lt; &gt;` decoded. Everything else,
 * `*bold*` included, stays as typed.
 */
export function slackDisplaySegments(
  text: string,
  mentions?: SlackMentionNames,
): SlackTextSegment[] {
  const segments: SlackTextSegment[] = [];
  const push = (segment: SlackTextSegment) => {
    if (segment.text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === "text" && segment.kind === "text") {
      last.text += segment.text;
      return;
    }
    segments.push({ ...segment });
  };
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    push({ kind: "text", text: decodeEntities(text.slice(cursor, start)) });
    push(readToken(match[1] ?? "", mentions) ?? { kind: "text", text: match[0] });
    cursor = start + match[0].length;
  }
  push({ kind: "text", text: decodeEntities(text.slice(cursor)) });
  return segments;
}

export function slackDisplayText(text: string, mentions?: SlackMentionNames): string {
  return slackDisplaySegments(text, mentions)
    .map((segment) => segment.text)
    .join("");
}

/** The first non-empty line of the display text, for a closed row's title. */
export function slackDisplayFirstLine(text: string, mentions?: SlackMentionNames): string {
  const line = slackDisplayText(text, mentions)
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? "";
}

export interface SlackEditableText {
  /** What the editor shows: safe mentions as `@이름`, everything else as stored. */
  editable: string;
  /** The names the editor shows, each to its user id; fromEditableSlackText reads only these. */
  names: Readonly<Record<string, string>>;
}

const BARE_MENTION = /<@([UW][A-Z0-9]{2,})>/g;
const ANY_MENTION = /<@[^<>\n]*>/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceNames(edited: string, names: Readonly<Record<string, string>>): string {
  const list = Object.keys(names).sort((a, b) => b.length - a.length);
  if (list.length === 0) return edited;
  const pattern = new RegExp(`@(${list.map(escapeRegExp).join("|")})`, "g");
  return edited.replace(pattern, (_match, name: string) => `<@${names[name]}>`);
}

function showNames(text: string, names: Readonly<Record<string, string>>): string {
  const byId = new Map(Object.entries(names).map(([name, id]) => [id, name]));
  return text.replace(BARE_MENTION, (match, id: string) => {
    const name = byId.get(id);
    return name ? `@${name}` : match;
  });
}

/**
 * The message as the text editor shows it. A bare `<@U…>` becomes `@이름` only when that name is
 * known, no other id in this message has the same name, and `@이름` does not already appear as
 * typed text; otherwise it stays in its code form. Labelled mentions (`<@U…|x>`) and all other
 * markup stay as stored. fromEditableSlackText(editable, names) gives the text back exactly.
 */
export function toEditableSlackText(text: string, mentions?: SlackMentionNames): SlackEditableText {
  const idsByName = new Map<string, Set<string>>();
  for (const match of text.matchAll(BARE_MENTION)) {
    const id = match[1] ?? "";
    const name = mentions?.[id]?.trim();
    if (!name) continue;
    const ids = idsByName.get(name) ?? new Set<string>();
    ids.add(id);
    idsByName.set(name, ids);
  }
  const typed = text.replace(ANY_MENTION, "\u0000");
  const candidates: Record<string, string> = {};
  for (const [name, ids] of idsByName) {
    if (ids.size !== 1 || typed.includes(`@${name}`)) continue;
    candidates[name] = [...ids][0] ?? "";
  }
  const withoutPrefixes = Object.fromEntries(
    Object.entries(candidates).filter(
      ([name]) =>
        !Object.keys(candidates).some((other) => other !== name && other.startsWith(name)),
    ),
  );
  // A name next to text that reads as a longer name could not come back exactly: check, then fall
  // back to fewer names, then to none.
  for (const names of [candidates, withoutPrefixes]) {
    const editable = showNames(text, names);
    if (replaceNames(editable, names) === text) return { editable, names };
  }
  return { editable: text, names: {} };
}

/** The editor's text back in Slack's form: each `@이름` from `names` becomes `<@U…>`. */
export function fromEditableSlackText(
  edited: string,
  names: Readonly<Record<string, string>>,
): string {
  return replaceNames(edited, names);
}
