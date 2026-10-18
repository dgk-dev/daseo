import type { BrowserTabLifecycle } from "./lifecycle.js";

// Freezing stops a parked tab's CPU but keeps its memory (measured on Electron 41: a 1.1 GB page
// stayed 1.1 GB frozen; navigating it to about:blank in place kept the same process and grew it).
// Only ending the renderer process gives the memory back, so under macOS memory pressure a tab
// that has been frozen and unused for a long time is discarded the way Chrome does: its renderer
// is ended while the WebContents keeps URL, title, and back/forward history, and the next wake
// reloads it (measured: 2.2 GB released, history and title intact, other tabs untouched).

// `sysctl kern.memorystatus_vm_pressure_level` reports the dispatch masks
// DISPATCH_MEMORYPRESSURE_NORMAL/WARN/CRITICAL = 1/2/4 (SDK dispatch/source.h; Chromium's
// system_memory_pressure_evaluator_mac.cc maps the same values).
export const MEMORY_PRESSURE_WARN = 2;
export const MEMORY_PRESSURE_CRITICAL = 4;
export const BROWSER_TAB_DISCARD_CHECK_MS = 30_000;
export const BROWSER_TAB_DISCARD_AFTER_IDLE_MS = 60 * 60_000;
export const BROWSER_TAB_DISCARD_AFTER_IDLE_CRITICAL_MS = 30 * 60_000;
/** Under a warning only a couple of tabs go per check; critical pressure discards every eligible tab. */
export const BROWSER_TAB_DISCARDS_PER_WARN_CHECK = 2;

type TimerHandle = ReturnType<typeof setInterval>;

export interface BrowserTabDiscarderOptions {
  lifecycle: Pick<BrowserTabLifecycle, "listDiscardCandidates" | "discard">;
  readPressureLevel: () => Promise<number | undefined>;
  /**
   * Tabs that must keep their page: typed into since their last document load, downloading,
   * exempt from freezing, not a plain tab, or sharing a renderer process with another page.
   */
  isDiscardBlocked: (webContentsId: number) => boolean;
  onDiscard?: (webContentsId: number, pressureLevel: number) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  setInterval?: (callback: () => void, intervalMs: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}

export class BrowserTabDiscarder {
  private timer: TimerHandle | null = null;
  private checking = false;

  public constructor(private readonly options: BrowserTabDiscarderOptions) {}

  public start(): void {
    if (this.timer !== null) {
      return;
    }
    const schedule = this.options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.timer = schedule(() => {
      void this.check();
    }, this.options.intervalMs ?? BROWSER_TAB_DISCARD_CHECK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  public stop(): void {
    if (this.timer === null) {
      return;
    }
    (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
  }

  /** One pressure check; resolves with the number of tabs discarded. */
  public async check(): Promise<number> {
    if (this.checking) {
      return 0;
    }
    this.checking = true;
    try {
      const level = await this.options.readPressureLevel();
      if (level === undefined || level < MEMORY_PRESSURE_WARN) {
        return 0;
      }
      const critical = level >= MEMORY_PRESSURE_CRITICAL;
      const minIdleMs = critical
        ? BROWSER_TAB_DISCARD_AFTER_IDLE_CRITICAL_MS
        : BROWSER_TAB_DISCARD_AFTER_IDLE_MS;
      const limit = critical ? Number.POSITIVE_INFINITY : BROWSER_TAB_DISCARDS_PER_WARN_CHECK;
      let discarded = 0;
      for (const candidate of this.options.lifecycle.listDiscardCandidates(minIdleMs)) {
        if (discarded >= limit) {
          break;
        }
        if (this.options.isDiscardBlocked(candidate.webContentsId)) {
          continue;
        }
        if (await this.options.lifecycle.discard(candidate.webContentsId, minIdleMs)) {
          discarded += 1;
          this.options.onDiscard?.(candidate.webContentsId, level);
        }
      }
      return discarded;
    } catch (error) {
      this.options.onError?.(error);
      return 0;
    } finally {
      this.checking = false;
    }
  }
}

// Keys that move focus or the caret without changing anything a page could lose on reload.
const NON_EDITING_KEYS = new Set([
  "Alt",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "CapsLock",
  "Control",
  "End",
  "Escape",
  "Home",
  "Meta",
  "PageDown",
  "PageUp",
  "Shift",
  "Tab",
]);

/**
 * Chrome never discards a tab the user typed into (tab_lifecycle_unit.cc "Do not discard tabs in
 * which the user has entered text in a form"). Electron exposes no form-interaction signal, so any
 * key press that could edit text counts, IME composition ("Process") included.
 */
export function isEditingKeyInput(input: { type: string; key: string }): boolean {
  if (input.type !== "keyDown") {
    return false;
  }
  if (NON_EDITING_KEYS.has(input.key)) {
    return false;
  }
  return !/^F\d{1,2}$/.test(input.key);
}

/** Agent commands that can leave unsaved input or page state behind. */
export const BROWSER_AUTOMATION_EDITING_COMMANDS: ReadonlySet<string> = new Set([
  "drag",
  "evaluate",
  "fill",
  "keypress",
  "select",
  "stream_input",
  "type",
  "upload",
]);
