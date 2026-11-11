// Daseo delta 92. A tab whose page script is stuck, or whose renderer crashed, used to cost every
// agent command a full timeout. Electron's `unresponsive` event does not cover agent tabs: it comes
// from Chromium's input hang monitor, and a busy-looping page an agent drives through scripts never
// raised it (measured with Electron 44.10.2: no event in 25 s, window shown, a mouse event sent).
// So the tab is checked directly: a page script that has not answered after a few seconds is
// followed by a trivial one, and when that gets no answer either the page's script thread is busy.
// Crashes come from `render-process-gone`, except the memory-pressure discard, which ends the
// renderer on purpose. Nothing here kills a renderer: forcefullyCrashRenderer can take down other
// pages sharing the process.

export const PAGE_BUSY_CHECK_AFTER_MS = 3_000;
export const PAGE_PING_TIMEOUT_MS = 1_500;
/**
 * Before each tab command one trivial script runs; a healthy page answers in milliseconds, even
 * while it loads. The allowance is wider than the in-command check so a page that blocks its
 * thread for a second or two (a heavy app booting) is not called busy.
 */
export const PAGE_PRECHECK_TIMEOUT_MS = 3_000;

export type RendererHealth =
  | { state: "not_responding"; since: number }
  | { state: "crashed"; reason: string; exitCode?: number };

export interface RendererHealthContents {
  readonly id: number;
  readonly mainFrame: { executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> };
  isDestroyed(): boolean;
  on?(event: "unresponsive" | "responsive" | "did-start-loading", listener: () => void): unknown;
  on?(
    event: "render-process-gone",
    listener: (event: unknown, details: { reason: string; exitCode?: number }) => void,
  ): unknown;
  once(event: "destroyed", listener: () => void): unknown;
}

export class PageNotRespondingError extends Error {
  public constructor(public readonly browserLabel: string) {
    super(
      `The page in ${browserLabel} is not responding: its script has been busy and did not answer a ${PAGE_PING_TIMEOUT_MS}ms check. Try browser_reload, or close the tab with browser_close_tab.`,
    );
    this.name = "PageNotRespondingError";
  }
}

interface Tracked {
  contents: RendererHealthContents;
  health: RendererHealth | null;
}

export interface RendererHealthOptions {
  /** True while the tab's renderer was ended on purpose (memory-pressure discard). */
  isIntentionalCrash?: (contentsId: number) => boolean;
  /**
   * Delta 93: true while the page waits on its own alert, confirm, or prompt. Its script thread
   * answers nothing then, but it is not busy.
   */
  isWaitingOnDialog?: (contentsId: number) => boolean;
  now?: () => number;
  checkAfterMs?: number;
  pingTimeoutMs?: number;
  precheckTimeoutMs?: number;
}

export class RendererHealthMonitor {
  private readonly tracked = new Map<number, Tracked>();
  private readonly now: () => number;
  private readonly checkAfterMs: number;
  private readonly pingTimeoutMs: number;
  private readonly precheckTimeoutMs: number;

  public constructor(private readonly options: RendererHealthOptions = {}) {
    this.now = options.now ?? Date.now;
    this.checkAfterMs = options.checkAfterMs ?? PAGE_BUSY_CHECK_AFTER_MS;
    this.pingTimeoutMs = options.pingTimeoutMs ?? PAGE_PING_TIMEOUT_MS;
    this.precheckTimeoutMs = options.precheckTimeoutMs ?? PAGE_PRECHECK_TIMEOUT_MS;
  }

  public observe(contents: RendererHealthContents): void {
    // Electron throws on `id` once the contents are destroyed, so it is read once here.
    const contentsId = contents.id;
    if (this.tracked.has(contentsId)) return;
    const entry: Tracked = { contents, health: null };
    this.tracked.set(contentsId, entry);
    contents.on?.("unresponsive", () => {
      if (entry.health?.state !== "crashed") {
        entry.health = { state: "not_responding", since: this.now() };
      }
    });
    contents.on?.("responsive", () => {
      if (entry.health?.state === "not_responding") entry.health = null;
    });
    contents.on?.("render-process-gone", (_event, details) => {
      if (this.options.isIntentionalCrash?.(contentsId) || details.reason === "clean-exit") {
        entry.health = null;
        return;
      }
      entry.health = {
        state: "crashed",
        reason: details.reason,
        ...(typeof details.exitCode === "number" ? { exitCode: details.exitCode } : {}),
      };
    });
    // A reload or navigation starts the page over (in a new renderer after a crash).
    contents.on?.("did-start-loading", () => {
      entry.health = null;
    });
    contents.once("destroyed", () => {
      this.tracked.delete(contentsId);
    });
  }

  public get(contentsId: number): RendererHealth | null {
    return this.tracked.get(contentsId)?.health ?? null;
  }

  /**
   * Before a command (after the tab is woken: a frozen page runs no script): null when the tab
   * can take it. The page gets one trivial script first, so a busy page fails here in seconds
   * instead of holding the command's DevTools and page work until their own deadlines, and a tab
   * that recovered runs the command at once.
   */
  public async blockingHealth(contentsId: number): Promise<RendererHealth | null> {
    const entry = this.tracked.get(contentsId);
    if (!entry) return null;
    if (entry.health?.state === "crashed") return entry.health;
    if (this.options.isWaitingOnDialog?.(contentsId)) return null;
    if (await this.ping(entry.contents, this.precheckTimeoutMs)) {
      entry.health = null;
      return null;
    }
    entry.health ??= { state: "not_responding", since: this.now() };
    return entry.health;
  }

  /**
   * Runs a page script, unless the page stops answering first: after `checkAfterMs` a trivial
   * script is sent, and when it gets no answer in `pingTimeoutMs` the call rejects with
   * PageNotRespondingError and the tab is marked. A slow script whose page still answers keeps
   * running; the caller's own deadline applies.
   */
  public runPageScript(
    contents: RendererHealthContents,
    code: string,
    userGesture: boolean | undefined,
    label: string,
  ): Promise<unknown> {
    const contentsId = contents.id;
    // WebFrameMain rejects an undefined userGesture ("userGesture must be a boolean").
    const script = contents.mainFrame.executeJavaScript(code, userGesture === true);
    let answered = false;
    const work = script.finally(() => {
      answered = true;
    });
    const watch = (async (): Promise<never | undefined> => {
      for (;;) {
        await delay(this.checkAfterMs);
        if (answered || contents.isDestroyed()) return undefined;
        if (this.options.isWaitingOnDialog?.(contentsId)) continue;
        if (await this.ping(contents)) continue;
        if (answered || this.options.isWaitingOnDialog?.(contentsId)) continue;
        const entry = this.tracked.get(contentsId);
        if (entry && entry.health?.state !== "crashed") {
          entry.health = { state: "not_responding", since: this.now() };
        }
        throw new PageNotRespondingError(label);
      }
    })();
    // The script's late result has no reader once the watch gave up.
    work.catch(() => {});
    return Promise.race([work, watch.then(() => work)]);
  }

  private async ping(
    contents: RendererHealthContents,
    timeoutMs = this.pingTimeoutMs,
  ): Promise<boolean> {
    if (contents.isDestroyed()) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const answered = contents.mainFrame.executeJavaScript("0", false).then(
      () => true as const,
      () => true as const,
    );
    try {
      return await Promise.race([answered, expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** The failure text for a command sent to an unhealthy tab. */
export function describeRendererHealth(browserId: string, health: RendererHealth): string {
  if (health.state === "crashed") {
    const code = health.exitCode === undefined ? "" : `, exit code ${health.exitCode}`;
    return `The renderer of tab ${browserId} crashed (${health.reason}${code}). browser_reload reopens the page.`;
  }
  return new PageNotRespondingError(`tab ${browserId}`).message;
}

/** Commands that can bring an unhealthy tab back, or do not need its page. */
export const RENDERER_RECOVERY_COMMANDS: ReadonlySet<string> = new Set([
  "list_tabs",
  "new_tab",
  "close_tab",
  "reload",
  "navigate",
  "back",
  "forward",
  "stream_stop",
  "passkeys",
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
