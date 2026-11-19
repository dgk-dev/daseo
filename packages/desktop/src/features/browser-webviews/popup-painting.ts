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
 *
 * Daseo delta 134: plain browser tabs take the same hold while they are awake and not on screen.
 * A page in a tab nobody looks at has no window focus, so `document.hasFocus()` stays false and
 * pages that gate a button on focus (Claude's OAuth "Authorize", an anti-clickjacking check) never
 * enable it for an agent. Under the hold the page reports focus and visibility as a tab being
 * recorded does. A tab a pane presents keeps real focus and blur; a tab counts as presented until
 * main learns otherwise, so a tab the person opens is never held on its way onto the screen.
 */
export interface FocusEmulationHoldPort {
  /** CDP `Emulation.setFocusEmulationEnabled` on the target's own debugger session. */
  setFocusEmulation(enabled: boolean): Promise<void>;
}

export function shouldHoldFocusEmulation(input: { awake: boolean; presented: boolean }): boolean {
  return input.awake && !input.presented;
}

export class FocusEmulationHold {
  private awake = false;
  private presented: boolean;
  /**
   * What the page was last told; null when unknown (a command failed). A debugger session starts
   * without focus emulation, so a new hold and a lost session both start from false.
   */
  private applied: boolean | null = false;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(
    private readonly port: FocusEmulationHoldPort,
    private readonly onError: (error: unknown) => void = () => {},
    options: { initiallyPresented?: boolean } = {},
  ) {
    this.presented = options.initiallyPresented ?? false;
  }

  /** The tab lifecycle's "background throttling off" (active) or "on" (throttled, frozen). */
  public setAwake(awake: boolean): void {
    this.awake = awake;
    this.sync();
  }

  /** The target is shown in the app window (true), or parked or in no pane (false). */
  public setPresented(presented: boolean): void {
    this.presented = presented;
    this.sync();
  }

  /**
   * The debugger session is gone, and with it any emulation it held. Only a hold that is still
   * wanted is sent again, so a target whose renderer is ending (a discarded tab) is not attached.
   */
  public invalidate(): void {
    this.applied = false;
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
    const desired = shouldHoldFocusEmulation({ awake: this.awake, presented: this.presented });
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
