import { isImeComposing, onImeCompositionEnd } from "@/composer/draft-sync/ime-composition";

/**
 * Daseo delta 139: what the owner is doing in each draft's composer on this device, so a draft
 * synced from another device never replaces text while he is writing it. A composer is busy while
 * dictation runs or is being transcribed, and, while it has focus, while an input method composes
 * or within `RECENT_EDIT_MS` of his last keystroke. Re-feeding the editor during any of these
 * ends an IME composition or overwrites a keyboard edit (upstream Paseo #3517).
 */
export const RECENT_EDIT_MS = 2000;

interface ActivityRecord {
  focused: boolean;
  dictating: boolean;
  lastLocalEditAt: number;
}

export interface ComposerActivitySource {
  isBusy(draftKey: string): boolean;
  /** Milliseconds until the "recent edit" part of busy ends, or null when it is not what holds. */
  msUntilEditIdle(draftKey: string): number | null;
  /** Called with a draft key whenever that composer may have stopped being busy. */
  onMaybeIdle(listener: (draftKey: string | null) => void): () => void;
}

export class ComposerActivity implements ComposerActivitySource {
  private readonly records = new Map<string, ActivityRecord>();
  private readonly listeners = new Set<(draftKey: string | null) => void>();
  private readonly now: () => number;
  private readonly isComposing: () => boolean;

  constructor(
    options: {
      now?: () => number;
      isComposing?: () => boolean;
      subscribeCompositionEnd?: (listener: () => void) => () => void;
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.isComposing = options.isComposing ?? isImeComposing;
    (options.subscribeCompositionEnd ?? onImeCompositionEnd)(() => this.emit(null));
  }

  setFocused(draftKey: string, focused: boolean): void {
    const record = this.record(draftKey);
    if (record.focused === focused) return;
    record.focused = focused;
    if (!focused) this.emit(draftKey);
  }

  setDictating(draftKey: string, dictating: boolean): void {
    const record = this.record(draftKey);
    if (record.dictating === dictating) return;
    record.dictating = dictating;
    if (!dictating) this.emit(draftKey);
  }

  noteLocalEdit(draftKey: string): void {
    this.record(draftKey).lastLocalEditAt = this.now();
  }

  isBusy(draftKey: string): boolean {
    const record = this.records.get(draftKey);
    if (!record) return false;
    if (record.dictating) return true;
    if (!record.focused) return false;
    return this.isComposing() || this.now() - record.lastLocalEditAt < RECENT_EDIT_MS;
  }

  msUntilEditIdle(draftKey: string): number | null {
    const record = this.records.get(draftKey);
    if (!record?.focused || record.dictating) return null;
    const remaining = record.lastLocalEditAt + RECENT_EDIT_MS - this.now();
    return remaining > 0 ? remaining : null;
  }

  onMaybeIdle(listener: (draftKey: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private record(draftKey: string): ActivityRecord {
    let record = this.records.get(draftKey);
    if (!record) {
      record = { focused: false, dictating: false, lastLocalEditAt: 0 };
      this.records.set(draftKey, record);
    }
    return record;
  }

  private emit(draftKey: string | null): void {
    for (const listener of this.listeners) listener(draftKey);
  }
}

export const composerActivity = new ComposerActivity();
