/**
 * Daseo delta 72: a long bare URL in an assistant reply shows its full host and a
 * shortened path, with the query and fragment collapsed; the link still opens and
 * copies the full address. Only links whose visible text is the URL itself are
 * shortened. A link the agent labelled keeps its label.
 */
const MAX_LABEL = 48;
const MAX_SEGMENT = 24;
const URL_PARTS = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i;

export function shortenBareUrlLabel(href: string, text: string | undefined): string | null {
  const label = text?.trim();
  if (!label || label.length <= MAX_LABEL) return null;
  if (!isSameAddress(label, href)) return null;

  const match = URL_PARTS.exec(href.trim());
  if (!match) return null;
  const host = match[2] ?? "";
  const path = match[3] ?? "";
  const suffix = `${match[4] ? "?…" : ""}${match[5] ? "#…" : ""}`;

  const segments = path.split("/").filter(Boolean);
  const plain = `${host}${path.replace(/\/$/, "")}${suffix}`;
  if (plain.length <= MAX_LABEL) return plain;
  if (segments.length === 0) return `${host}${suffix}`;

  const last = clip(segments[segments.length - 1] ?? "");
  if (segments.length === 1) return `${host}/${last}${suffix}`;

  const withFirst = `${host}/${clip(segments[0] ?? "")}/…/${last}${suffix}`;
  if (withFirst.length <= MAX_LABEL) return withFirst;
  return `${host}/…/${last}${suffix}`;
}

function clip(segment: string): string {
  return segment.length > MAX_SEGMENT ? `${segment.slice(0, MAX_SEGMENT - 1)}…` : segment;
}

function isSameAddress(label: string, href: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^mailto:/i, "")
      .replace(/\/$/, "");
  return normalize(label) === normalize(href);
}
