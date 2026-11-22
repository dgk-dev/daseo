/**
 * Daseo delta 135: the longest scheduled Slack message text, in characters (code points). pi-local
 * `slack_post` accepts up to 40,000, so the daemon sends the text uncut up to this length and
 * refuses a longer new text; the app's 내용 수정 refuses to start from a text this long, because a
 * text at the cap may have been cut and saving it would schedule the cut message.
 */
export const SLACK_SCHEDULED_TEXT_MAX_CHARS = 40_000;
