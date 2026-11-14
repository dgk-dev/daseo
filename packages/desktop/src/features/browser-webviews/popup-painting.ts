/**
 * Daseo delta 107: a parked popup keeps painting while it is awake.
 *
 * Popup targets live in a never-shown native parking window (popup-targets.ts). Two Electron 44
 * behaviors left them without animation frames, so a page that reports back to its opener from
 * `requestAnimationFrame` (CapSolver's Google sign-in, for one) never did:
 *
 * - `webContents.setBackgroundThrottling(false)`, which the tab lifecycle used to call on attach
 *   and on every wake, keeps a widget "shown" when content hides it. When a sign-in popup goes to
 *   the identity provider and comes back to its opener's site, Chromium reuses the opener-site
 *   widget it swapped out; the reused widget was never hidden, so it is never shown again and its
 *   surface is never embedded: `visibilityState` says visible, rAF never runs.
 * - A popup the user presented and then left is moved back into the parking window; that hides
 *   it, and a window that is never shown never shows it again.
 *
 * Popups therefore keep Chromium's default throttling for their whole life, and "awake" for a
 * popup is a DevTools focus emulation hold instead: Chromium implements focus emulation as a
 * visible capture, the same hidden-but-captured state a tab being recorded is in, so the page
 * renders and reports visible wherever its view sits. The hold is taken only while the popup is
 * parked; a presented popup is really on screen and keeps real focus and blur. When the lifecycle
 * lets the popup idle (throttled, then frozen) the hold is released and the page sleeps like a
 * background page in Chrome.
 */
export interface PopupPaintHoldPort {
  /** CDP `Emulation.setFocusEmulationEnabled` on the popup's own debugger session. */
  setFocusEmulation(enabled: boolean): Promise<void>;
}

export function shouldHoldPopupPainting(input: { awake: boolean; presented: boolean }): boolean {
  return input.awake && !input.presented;
}

export class PopupPaintHold {
  private awake = false;
  private presented = false;
  /** What the page was last told; null when unknown (never told, failed, or debugger detached). */
  private applied: boolean | null = null;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(
    private readonly port: PopupPaintHoldPort,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** The tab lifecycle's "background throttling off" (active) or "on" (throttled, frozen). */
  public setAwake(awake: boolean): void {
    this.awake = awake;
    this.sync();
  }

  /** The popup's native view is shown in the app window (true) or parked (false). */
  public setPresented(presented: boolean): void {
    this.presented = presented;
    this.sync();
  }

  /** The debugger session that held the emulation is gone; apply the current state again. */
  public invalidate(): void {
    this.applied = null;
    this.sync();
  }

  public isHeld(): boolean {
    return this.applied === true;
  }

  public dispose(): void {
    this.disposed = true;
  }

  /** Settles once every command issued so far has been answered. */
  public whenSettled(): Promise<void> {
    return this.chain;
  }

  private sync(): void {
    if (this.disposed) return;
    const desired = shouldHoldPopupPainting({ awake: this.awake, presented: this.presented });
    if (desired === this.applied) return;
    this.applied = desired;
    this.chain = this.chain.then(() => this.apply(desired));
  }

  private async apply(desired: boolean): Promise<void> {
    if (this.disposed) return;
    try {
      await this.port.setFocusEmulation(desired);
    } catch (error) {
      // Unknown again, so the next change retries instead of trusting a command that failed.
      if (this.applied === desired) this.applied = null;
      this.onError(error);
    }
  }
}
