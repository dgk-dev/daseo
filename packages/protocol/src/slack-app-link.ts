// Daseo delta 135: the one non-web link the openers accept. pi-local builds a sent Slack message's
// app link (`slack://channel?team=T…&id=C…&message=<ts>[&thread_ts=<ts>]`); the daemon passes it
// on and the app opens it only when it has exactly this shape. Any other `slack:` path, parameter,
// value, fragment, or a repeated parameter is refused, so forge-supplied URLs cannot reach a
// general custom-scheme opener. Keep in step with `isSlackAppLink` in the desktop opener.

const SLACK_APP_LINK_PREFIX = "slack://channel?";
const SLACK_APP_LINK_MAX_LENGTH = 200;
const SLACK_APP_LINK_PARAMS: Readonly<Record<string, RegExp>> = {
  team: /^[TE][A-Z0-9]{2,20}$/,
  id: /^[CDG][A-Z0-9]{2,20}$/,
  message: /^\d{10}\.\d{6}$/,
  thread_ts: /^\d{10}\.\d{6}$/,
};
const SLACK_APP_LINK_REQUIRED = ["team", "id", "message"];

export function isSlackAppLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > SLACK_APP_LINK_MAX_LENGTH) {
    return false;
  }
  if (!value.startsWith(SLACK_APP_LINK_PREFIX)) {
    return false;
  }
  const seen = new Set<string>();
  for (const pair of value.slice(SLACK_APP_LINK_PREFIX.length).split("&")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      return false;
    }
    const key = pair.slice(0, separator);
    const pattern = SLACK_APP_LINK_PARAMS[key];
    if (!pattern || seen.has(key) || !pattern.test(pair.slice(separator + 1))) {
      return false;
    }
    seen.add(key);
  }
  return SLACK_APP_LINK_REQUIRED.every((key) => seen.has(key));
}
