/**
 * Daseo: recognizes a daemon assistant image snapshot (`…/assistant-images/blobs/<sha256>.<ext>`).
 * Its bytes never change, so the app can key its copy by host and hash instead of by message.
 */
const SNAPSHOT_PATH = /[/\\]assistant-images[/\\]blobs[/\\]([0-9a-f]{64})\.([a-z0-9]+)$/;

export function parseAssistantImageSnapshotPath(
  path: string,
): { hash: string; ext: string } | null {
  const match = path.match(SNAPSHOT_PATH);
  return match ? { hash: match[1], ext: match[2] } : null;
}
