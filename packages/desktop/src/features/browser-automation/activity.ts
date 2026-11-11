export class BrowserAutomationActivityTracker {
  private readonly lastActivityByWebContentsId = new Map<number, number>();

  public constructor(
    private readonly now: () => number = Date.now,
    private readonly graceMs = 1_000,
  ) {}

  public mark(webContentsId: number): void {
    this.lastActivityByWebContentsId.set(webContentsId, this.now());
  }

  public wasRecent(webContentsId: number): boolean {
    const lastActivity = this.lastActivityByWebContentsId.get(webContentsId);
    if (lastActivity === undefined) {
      return false;
    }
    if (this.now() - lastActivity <= this.graceMs) {
      return true;
    }
    this.lastActivityByWebContentsId.delete(webContentsId);
    return false;
  }

  public clear(webContentsId: number): void {
    this.lastActivityByWebContentsId.delete(webContentsId);
  }
}

const browserAutomationActivity = new BrowserAutomationActivityTracker();
// Delta 92: a download within a minute of an agent's last command on the tab is the agent's (the
// click that starts one can take a moment to turn into a response).
export const BROWSER_AGENT_DRIVEN_WINDOW_MS = 60_000;
const agentDrivenActivity = new BrowserAutomationActivityTracker(
  Date.now,
  BROWSER_AGENT_DRIVEN_WINDOW_MS,
);

export function markPaseoBrowserAutomationActivity(webContentsId: number): void {
  browserAutomationActivity.mark(webContentsId);
  agentDrivenActivity.mark(webContentsId);
}

export function wasPaseoBrowserAgentDriven(webContentsId: number): boolean {
  return agentDrivenActivity.wasRecent(webContentsId);
}

export function wasPaseoBrowserRecentlyAutomated(webContentsId: number): boolean {
  return browserAutomationActivity.wasRecent(webContentsId);
}

export function clearPaseoBrowserAutomationActivity(webContentsId: number): void {
  browserAutomationActivity.clear(webContentsId);
  agentDrivenActivity.clear(webContentsId);
}
