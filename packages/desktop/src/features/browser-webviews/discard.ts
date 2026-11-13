import type { BrowserTabLifecycle } from "./lifecycle.js";

// Freezing stops a parked tab's CPU but keeps its memory (measured on Electron 41: a 1.1 GB page
// stayed 1.1 GB frozen; navigating it to about:blank in place kept the same process and grew it).
// Only ending the renderer process gives the memory back, so a tab that has been frozen and unused
// for a long time is discarded the way Chrome does: its renderer is ended while the WebContents
// keeps URL, title, and back/forward history, and the next wake reloads it (measured: 2.2 GB
// released, history and title intact, other tabs untouched). Delta 43 did this only under macOS
// memory pressure; a Mac that never reported pressure kept 16-hour-old renderers forever (10 of
// them held 2.8 GB on 2026-11-13), so delta 97 also discards after a long idle time without it.

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
/**
 * Delta 97: without memory pressure a tab is discarded after three hours unused, one per check.
 * Chrome's Memory Saver discards after at most two hours and Edge's sleeping tabs after two; three
 * keeps a tab someone comes back to after a long meeting.
 */
export const BROWSER_TAB_DISCARD_AFTER_IDLE_NORMAL_MS = 180 * 60_000;
export const BROWSER_TAB_DISCARDS_PER_IDLE_CHECK = 1;
/** A candidate kept for a reason is logged at most this often per tab. */
export const BROWSER_TAB_DISCARD_SKIP_LOG_INTERVAL_MS = 60 * 60_000;

/** Why a discard candidate keeps its page. */
export type BrowserTabDiscardBlockReason =
  /** Typed into, or edited without a key, since its last document load; unknown counts. */
  | "edited"
  | "downloading"
  /** Exempt from freezing: a running network capture, or a page dialog waiting for an answer. */
  | "freeze-exempt"
  /** Its WebContents is gone or cannot be found. */
  | "destroyed"
  /** No renderer process id to check sharing against. */
  | "no-pid"
  /** Its renderer process also runs another page, which ending it would take down. */
  | "shared-renderer";

export type BrowserTabDiscardTrigger =
  | { readonly kind: "pressure"; readonly pressureLevel: number }
  | { readonly kind: "idle" };

export interface BrowserTabDiscardEvent {
  readonly webContentsId: number;
  readonly idleMinutes: number;
  readonly trigger: BrowserTabDiscardTrigger;
}

export interface BrowserTabDiscardSkip {
  readonly webContentsId: number;
  readonly idleMinutes: number;
  readonly reason: BrowserTabDiscardBlockReason;
}

type TimerHandle = ReturnType<typeof setInterval>;

export interface BrowserTabDiscarderOptions {
  lifecycle: Pick<BrowserTabLifecycle, "listDiscardCandidates" | "discard">;
  readPressureLevel: () => Promise<number | undefined>;
  /** Why a candidate must keep its page, or null when it may be discarded. */
  isDiscardBlocked: (webContentsId: number) => BrowserTabDiscardBlockReason | null;
  /** Unused time after which a frozen tab is discarded without memory pressure; 0 turns it off. */
  idleDiscardAfterMs?: number;
  onDiscard?: (event: BrowserTabDiscardEvent) => void;
  /** A candidate kept for a reason, at most once per BROWSER_TAB_DISCARD_SKIP_LOG_INTERVAL_MS. */
  onSkip?: (skip: BrowserTabDiscardSkip) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  now?: () => number;
  setInterval?: (callback: () => void, intervalMs: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}

export class BrowserTabDiscarder {
  private timer: TimerHandle | null = null;
  private checking = false;
  private idleDiscardAfterMs: number;
  private readonly now: () => number;
  private readonly skipLoggedAt = new Map<number, number>();

  public constructor(private readonly options: BrowserTabDiscarderOptions) {
    this.idleDiscardAfterMs = normalizeIdleDiscardAfterMs(
      options.idleDiscardAfterMs ?? BROWSER_TAB_DISCARD_AFTER_IDLE_NORMAL_MS,
    );
    this.now = options.now ?? Date.now;
  }

  /** 0 turns the discard without memory pressure off; pressure discards are unaffected. */
  public setIdleDiscardAfterMs(idleDiscardAfterMs: number): void {
    this.idleDiscardAfterMs = normalizeIdleDiscardAfterMs(idleDiscardAfterMs);
  }

  public getIdleDiscardAfterMs(): number {
    return this.idleDiscardAfterMs;
  }

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

  /**
   * One check; resolves with the number of tabs discarded. Under memory pressure the pressure
   * rules apply; otherwise one tab unused for the idle time, if that is on.
   */
  public async check(): Promise<number> {
    if (this.checking) {
      return 0;
    }
    this.checking = true;
    try {
      const level = await this.options.readPressureLevel();
      const plan = this.planCheck(level);
      if (!plan) {
        return 0;
      }
      this.forgetOldSkips();
      let discarded = 0;
      for (const candidate of this.options.lifecycle.listDiscardCandidates(plan.minIdleMs)) {
        if (discarded >= plan.limit) {
          break;
        }
        const idleMinutes = Math.floor((this.now() - candidate.lastUsedAt) / 60_000);
        const reason = this.options.isDiscardBlocked(candidate.webContentsId);
        if (reason !== null) {
          this.reportSkip({ webContentsId: candidate.webContentsId, idleMinutes, reason });
          continue;
        }
        if (await this.options.lifecycle.discard(candidate.webContentsId, plan.minIdleMs)) {
          discarded += 1;
          this.skipLoggedAt.delete(candidate.webContentsId);
          this.options.onDiscard?.({
            webContentsId: candidate.webContentsId,
            idleMinutes,
            trigger: plan.trigger,
          });
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

  private planCheck(
    level: number | undefined,
  ): { minIdleMs: number; limit: number; trigger: BrowserTabDiscardTrigger } | null {
    if (level !== undefined && level >= MEMORY_PRESSURE_WARN) {
      const critical = level >= MEMORY_PRESSURE_CRITICAL;
      const pressureMinIdleMs = critical
        ? BROWSER_TAB_DISCARD_AFTER_IDLE_CRITICAL_MS
        : BROWSER_TAB_DISCARD_AFTER_IDLE_MS;
      return {
        // A shorter idle setting is never made longer by pressure.
        minIdleMs:
          this.idleDiscardAfterMs > 0
            ? Math.min(pressureMinIdleMs, this.idleDiscardAfterMs)
            : pressureMinIdleMs,
        limit: critical ? Number.POSITIVE_INFINITY : BROWSER_TAB_DISCARDS_PER_WARN_CHECK,
        trigger: { kind: "pressure", pressureLevel: level },
      };
    }
    if (this.idleDiscardAfterMs > 0) {
      return {
        minIdleMs: this.idleDiscardAfterMs,
        limit: BROWSER_TAB_DISCARDS_PER_IDLE_CHECK,
        trigger: { kind: "idle" },
      };
    }
    return null;
  }

  private reportSkip(skip: BrowserTabDiscardSkip): void {
    if (this.skipLoggedAt.has(skip.webContentsId)) {
      return;
    }
    this.skipLoggedAt.set(skip.webContentsId, this.now());
    this.options.onSkip?.(skip);
  }

  private forgetOldSkips(): void {
    const now = this.now();
    for (const [webContentsId, loggedAt] of this.skipLoggedAt) {
      if (now - loggedAt >= BROWSER_TAB_DISCARD_SKIP_LOG_INTERVAL_MS) {
        this.skipLoggedAt.delete(webContentsId);
      }
    }
  }
}

function normalizeIdleDiscardAfterMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
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
