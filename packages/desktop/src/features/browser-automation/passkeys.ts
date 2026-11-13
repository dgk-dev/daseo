import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  BrowserAutomationPasskeyInfo,
  BrowserAutomationPasskeysResult,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { CdpSessionQueue } from "./cdp-session-queue.js";

// Daseo delta 78. Electron enables no platform authenticator, so a site's passkey request in a
// browser tab hung with no dialog until the page gave up (measured 2026-11-02: still pending
// after its own 30 s timeout). The OS passkey sheet (iCloud Keychain, 1Password) is out of
// reach: Chromium gates it on Apple's web-browser entitlement, and Electron 45's
// platformPasskeys only serves an app's own associated domain. So every browser tab gets
// Chromium's virtual authenticator through CDP: one software authenticator whose credentials
// live in an encrypted file owned by this app. A site that has no stored passkey fails at once
// (NotAllowedError in a few ms) instead of hanging; a passkey a site registers is persisted and
// served to every later tab; a stored passkey signs in with no Touch ID or phone.
//
// Chromium 146 (Electron 41) dropped the virtual authenticator environment on every
// cross-document navigation; Chromium 152 (Electron 44) keeps it and allows one internal
// authenticator per environment (both measured in the capture harness). So the installer re-runs
// on each main-frame commit and first removes the tab's previous authenticator, which is gone
// already on the older engine. A discoverable-credential get() needs the session's
// select-webauthn-account answer, otherwise Electron cancels it.
//
// Delta 92: private keys are sealed with an app key (AES-256-GCM, node:crypto) that lives in
// 1Password and reaches the app through ~/.config/agent-secrets/common.env, which the login shell
// environment brings into the main process. The macOS keychain is never asked: the app is signed
// without a Team ID, so every new build lost the keychain's "Always Allow", and the prompt that
// followed each swap held the main thread (85+ minutes after the 0.5.105 swap). Without the key
// passkeys are off for that run; there is no keychain fallback.
//
// Delta 102: a stored passkey never signs in by itself. Login pages start a conditional-mediation
// request on load (passkey autofill), which a real browser leaves pending until the person picks
// a passkey; the virtual authenticator answered it at once, so opening GitHub's login page signed
// straight back in and no other account was reachable. Electron's request delegate ignores the
// request's mediation (it never overrides SetUIPresentation), so nothing browser-side says
// conditional or modal. The hold point is the session's select-webauthn-account answer, which every
// discoverable get() reaches (one account included, measured on Electron 44.10.2) and which keeps
// the request pending until it is called. The request is answered at once only when the tab has
// transient user activation (a person's click or key, or an agent's tool click, within Chromium's
// activation window), read in an isolated world so the page's built-ins stay untouched, and the
// tab has not navigated since that click or key: a click on the site's passkey button starts a
// request under activation, a page load or a link navigation does not, and a client-side route
// change (pushState) keeps the click's activation, so a request after one waits for confirmation
// in the tab. Everything else waits until an agent calls browser_passkeys use or, when the site
// has two or more stored accounts or the page navigated after the click, the person picks in the
// tab. Presence simulation was measured
// and rejected: with presence off the request never reaches the picker and turning presence back
// on does not revive it.

export interface StoredPasskey {
  /** base64url without padding, equal to PublicKeyCredential.id on the page. */
  credentialId: string;
  rpId: string;
  /**
   * On disk: the PKCS#8 private key sealed with the app key. Empty in the copies
   * `PasskeyStore.list()` and `get()` return: the plain key comes from `keyOf`.
   */
  privateKey: string;
  /** Standard base64, as CDP carries it. */
  userHandle?: string;
  userName?: string;
  userDisplayName?: string;
  signCount: number;
  createdAt: string;
  lastUsedAt?: string;
  createdOnUrl?: string;
}

interface StoreFile {
  version: 2;
  cipher: "aes-256-gcm";
  /** Identifies the app key the entries are sealed with (sha256 prefix of the key). */
  keyId: string;
  passkeys: StoredPasskey[];
}

/** Environment variable holding the app key: 32 random bytes, standard base64. */
export const PASSKEY_KEY_ENV = "PERSONAL_DASEO_PASSKEY_KEY";

const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** AES-256-GCM with the app key. Sealed form: base64(iv | tag | ciphertext). */
export class PasskeyCipher {
  public readonly keyId: string;

  private constructor(private readonly key: Buffer) {
    this.keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  }

  /** The cipher for a base64 32-byte key, or why there is none. Never logs the key. */
  public static fromBase64(
    value: string | undefined,
  ): { ok: true; cipher: PasskeyCipher } | { ok: false; reason: string } {
    if (!value || value.trim().length === 0) {
      return { ok: false, reason: `${PASSKEY_KEY_ENV} is not set` };
    }
    const key = Buffer.from(value.trim(), "base64");
    if (key.length !== AES_KEY_BYTES) {
      return { ok: false, reason: `${PASSKEY_KEY_ENV} is not a base64 ${AES_KEY_BYTES}-byte key` };
    }
    return { ok: true, cipher: new PasskeyCipher(key) };
  }

  public seal(plain: string): string {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  /** Throws when the text was sealed with another key or was altered. */
  public open(sealed: string): string {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length < GCM_IV_BYTES + GCM_TAG_BYTES) throw new Error("sealed passkey is truncated");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, GCM_IV_BYTES));
    decipher.setAuthTag(raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(GCM_IV_BYTES + GCM_TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  }
}

/** The store on disk was sealed with a different app key; it is left untouched. */
export class PasskeyKeyMismatchError extends Error {
  public constructor(filePath: string) {
    super(`${filePath} was sealed with a different ${PASSKEY_KEY_ENV}`);
    this.name = "PasskeyKeyMismatchError";
  }
}

export type PasskeyLog = (message: string, detail?: Record<string, unknown>) => void;

export class PasskeyStore {
  private file: StoreFile;
  /** Plain private keys (base64) for this app run. Main process memory only; never logged. */
  private readonly keys = new Map<string, string>();

  /** Throws PasskeyKeyMismatchError when the file belongs to another app key. */
  public constructor(
    public readonly filePath: string,
    private readonly cipher: PasskeyCipher,
    private readonly log: PasskeyLog = () => {},
  ) {
    this.file = { version: 2, cipher: "aes-256-gcm", keyId: cipher.keyId, passkeys: [] };
    this.load();
  }

  /** Records without private keys; use `keyOf` for the key. */
  public list(): StoredPasskey[] {
    return this.file.passkeys.map(publicCopy);
  }

  public get(credentialId: string): StoredPasskey | undefined {
    const found = this.file.passkeys.find((passkey) => passkey.credentialId === credentialId);
    return found ? publicCopy(found) : undefined;
  }

  /** The private key as CDP expects it (plain base64). */
  public keyOf(credentialId: string): string | undefined {
    return this.keys.get(credentialId);
  }

  /** Adds a passkey; returns false when one with that credential id already exists. */
  public add(passkey: StoredPasskey): boolean {
    if (this.file.passkeys.some((existing) => existing.credentialId === passkey.credentialId)) {
      return false;
    }
    this.file.passkeys.push({ ...passkey, privateKey: this.cipher.seal(passkey.privateKey) });
    this.keys.set(passkey.credentialId, passkey.privateKey);
    this.write();
    return true;
  }

  /**
   * Records a signature: the counter always, `lastUsedAt` only when the assertion reached the site
   * (`usedAt`). A held request has already been signed by the authenticator but was never used.
   */
  public touch(
    credentialId: string,
    signCount: number,
    usedAt?: string,
  ): StoredPasskey | undefined {
    const passkey = this.file.passkeys.find((existing) => existing.credentialId === credentialId);
    if (!passkey) return undefined;
    const nextCount = Math.max(passkey.signCount, signCount);
    if (nextCount === passkey.signCount && usedAt === undefined) return publicCopy(passkey);
    passkey.signCount = nextCount;
    if (usedAt !== undefined) passkey.lastUsedAt = usedAt;
    this.write();
    return publicCopy(passkey);
  }

  public remove(credentialId: string): boolean {
    const before = this.file.passkeys.length;
    this.file.passkeys = this.file.passkeys.filter((p) => p.credentialId !== credentialId);
    if (this.file.passkeys.length === before) return false;
    this.keys.delete(credentialId);
    this.write();
    return true;
  }

  private load(): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
    } catch {
      // Missing or unreadable: start empty. An unreadable file is only replaced, atomically,
      // when a passkey is added.
      return;
    }
    if (parsed.version === 2) {
      if (parsed.keyId !== this.cipher.keyId) throw new PasskeyKeyMismatchError(this.filePath);
      const entries = Array.isArray(parsed.passkeys) ? parsed.passkeys.filter(isStoredPasskey) : [];
      for (const entry of entries) {
        try {
          this.keys.set(entry.credentialId, this.cipher.open(entry.privateKey));
          this.file.passkeys.push(entry);
        } catch (error) {
          // Kept on disk; a damaged entry is skipped for this run instead of failing installs.
          this.log("[browser-passkeys] skipped a stored passkey that does not decrypt", {
            rpId: entry.rpId,
            error: String(error),
          });
        }
      }
      return;
    }
    // The format before delta 92 sealed keys with the macOS keychain. Reading it would ask the
    // keychain, so its passkeys are dropped and registered again at the next sign-in.
    const legacy = Array.isArray(parsed.passkeys) ? parsed.passkeys.filter(isStoredPasskey) : [];
    this.write();
    this.log("[browser-passkeys] dropped passkeys stored in the keychain-sealed format", {
      count: legacy.length,
      rpIds: legacy.map((passkey) => passkey.rpId),
    });
  }

  private write(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }
}

function publicCopy(passkey: StoredPasskey): StoredPasskey {
  return { ...passkey, privateKey: "" };
}

function isStoredPasskey(value: unknown): value is StoredPasskey {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.credentialId === "string" &&
    typeof record.rpId === "string" &&
    typeof record.privateKey === "string" &&
    typeof record.signCount === "number" &&
    typeof record.createdAt === "string"
  );
}

// --- CDP shapes ---------------------------------------------------------------------------

/** WebAuthn.Credential as Chromium sends and accepts it. Binary fields are standard base64. */
interface CdpCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  userName?: string;
  userDisplayName?: string;
  backupEligibility?: boolean;
  backupState?: boolean;
}

// A platform authenticator with user verification, so sites treat it like Touch ID; backup
// flags set, so relying parties treat it as a synced passkey (no strict counter expectations).
export const VIRTUAL_AUTHENTICATOR_OPTIONS = {
  protocol: "ctap2",
  ctap2Version: "ctap2_1",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
  defaultBackupEligibility: true,
  defaultBackupState: true,
} as const;

export function toBase64Url(standardBase64: string): string {
  return standardBase64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(base64url: string): string {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  return base64 + "=".repeat((4 - (base64.length % 4)) % 4);
}

// Delta 94. Chromium's virtual authenticator refuses a site's create() once it holds three
// discoverable credentials (CTAP2_ERR_KEY_STORE_FULL, surfaced to the page as NotAllowedError
// within milliseconds; measured on Electron 44.10.2, 2026-11-11). Loading every stored passkey
// as discoverable made the fourth registration fail on every site. Credentials loaded as
// non-discoverable do not count (20 loaded, create() still succeeded) and still sign in when
// the site names them in allowCredentials. So a tab holds at most two discoverable credentials,
// the most recently used ones of its own site; every other stored passkey rides along
// non-discoverable, and one slot stays free for a registration.
export const DISCOVERABLE_SLOTS = 2;

/** Stored passkeys in load order with their role in a tab that shows `host`. */
export function planTabCredentials(
  passkeys: readonly StoredPasskey[],
  host: string | undefined,
): Array<{ passkey: StoredPasskey; discoverable: boolean }> {
  const recent = (passkey: StoredPasskey) => passkey.lastUsedAt ?? passkey.createdAt;
  const own = passkeys
    .filter((passkey) => host !== undefined && hostMatchesRpId(host, passkey.rpId))
    .sort((a, b) => recent(b).localeCompare(recent(a)));
  const discoverable = new Set(own.slice(0, DISCOVERABLE_SLOTS).map((p) => p.credentialId));
  return passkeys.map((passkey) => ({
    passkey,
    discoverable: discoverable.has(passkey.credentialId),
  }));
}

function toCdpCredential(
  passkey: StoredPasskey,
  privateKey: string,
  discoverable: boolean,
): CdpCredential {
  return {
    credentialId: fromBase64Url(passkey.credentialId),
    isResidentCredential: discoverable,
    rpId: passkey.rpId,
    privateKey,
    ...(discoverable && passkey.userHandle ? { userHandle: passkey.userHandle } : {}),
    signCount: passkey.signCount,
    ...(passkey.userName ? { userName: passkey.userName } : {}),
    ...(passkey.userDisplayName ? { userDisplayName: passkey.userDisplayName } : {}),
    backupEligibility: true,
    backupState: true,
  };
}

// --- Tabs ---------------------------------------------------------------------------------

export interface PasskeyTabDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
  on?(
    event: "message",
    listener: (event: unknown, method: string, params?: Record<string, unknown>) => void,
  ): unknown;
  on?(event: "detach", listener: () => void): unknown;
}

export interface PasskeyTabContents {
  readonly id: number;
  readonly debugger: PasskeyTabDebugger;
  isDestroyed(): boolean;
  getURL(): string;
  on(
    event: "did-navigate" | "did-navigate-in-page" | "dom-ready" | "input-event",
    listener: (...args: unknown[]) => void,
  ): unknown;
  once(event: "destroyed", listener: () => void): unknown;
}

export interface WebAuthnAccountChoice {
  credentialId: string;
  name?: string;
  displayName?: string;
  userHandle?: string;
}

export interface PasskeySession {
  on(
    event: "select-webauthn-account",
    listener: (
      event: unknown,
      details: {
        relyingPartyId: string;
        accounts: WebAuthnAccountChoice[];
        /** Electron's WebFrameMain of the requesting frame; null once it navigated or closed. */
        frame?: unknown;
      },
      callback: (credentialId?: string | null) => void,
    ) => void,
  ): unknown;
}

/** One stored account a waiting request could sign in with. */
export interface PasskeyRequestAccount {
  /** base64url, as `browser_passkeys list` shows it. */
  credentialId: string;
  userName?: string;
  userDisplayName?: string;
}

/**
 * Delta 102. Why a passkey request waits: `no_gesture` started with no click or key in the tab
 * (page load, link navigation), `choose_account` was asked for with a click or key and the site has
 * two or more stored accounts, `navigated_after_gesture` came after a click or key that the page
 * followed with a navigation (a client-side route change keeps the click's activation, so it may be
 * the login view's autofill, not a passkey button), and waits for someone to confirm it.
 */
export type PasskeyRequestWait = "no_gesture" | "choose_account" | "navigated_after_gesture";

/** Reasons the person sees as a card in the tab, each cancelled after PASSKEY_CHOICE_HOLD_MS. */
function waitsInPane(reason: PasskeyRequestWait): boolean {
  return reason !== "no_gesture";
}

/**
 * Input that gives a page user activation, as Electron's `input-event` names it (person input,
 * CDP-dispatched input, and `sendInputEvent`; measured on 44.10.2).
 */
const GESTURE_INPUT_TYPES = new Set([
  "mouseDown",
  "mouseUp",
  "rawKeyDown",
  "keyDown",
  "touchStart",
  "touchEnd",
  "gestureTap",
]);

export interface WaitingPasskeyRequest {
  readonly id: string;
  readonly contentsId: number;
  readonly rpId: string;
  readonly accounts: readonly PasskeyRequestAccount[];
  readonly reason: PasskeyRequestWait;
  /** Epoch ms. */
  readonly since: number;
  /** A request shown in the pane: when it is cancelled unanswered (epoch ms). */
  readonly expiresAt?: number;
}

/** The tab's pane, which shows a `choose_account` request to the person. */
export interface PasskeyChoiceSurface {
  show(request: WaitingPasskeyRequest): void;
  hide(contentsId: number, requestId: string): void;
}

export type PasskeyUseOutcome =
  | { kind: "used"; request: WaitingPasskeyRequest; account: PasskeyRequestAccount }
  | { kind: "choose"; request: WaitingPasskeyRequest; unmatchedAccount?: string }
  | { kind: "none" };

/** How long a person or agent has to pick an account before the request is cancelled. */
export const PASSKEY_CHOICE_HOLD_MS = 60_000;
/** Reading the tab's user activation must finish well inside Chromium's 5 s activation window. */
const ACTIVATION_READ_TIMEOUT_MS = 2_000;
const ACTIVATION_WORLD_NAME = "daseo-passkeys";

interface HeldRequest {
  request: WaitingPasskeyRequest;
  /** Requests are per frame: a newer request from the same frame means this one ended. */
  frameKey: string;
  answer: (credentialId: string | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface TabState {
  contents: PasskeyTabContents;
  queue: CdpSessionQueue;
  authenticatorId: string | null;
  /** Credential ids (base64url) currently loaded into this tab's authenticator. */
  loaded: Set<string>;
  /** The loaded ids that are discoverable; kept at or under DISCOVERABLE_SLOTS by install. */
  discoverable: Set<string>;
  /** Increments per install so a stale install cannot overwrite a newer one. */
  generation: number;
  /** Delta 102: passkey requests waiting for someone to ask, newest last. */
  held: HeldRequest[];
  /** Delta 102: last click or key in the tab (epoch ms): person, CDP, or an agent's tool click. */
  lastGestureAt: number;
  /** Delta 102: last main-frame navigation of any kind, in-page ones included (epoch ms). */
  lastNavigationAt: number;
}

export interface PasskeyHubOptions {
  store: PasskeyStore;
  now?: () => Date;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** The WebContents id of a requesting frame (Electron: `webContents.fromFrame(frame)?.id`). */
  contentsIdOfFrame?: (frame: unknown) => number | undefined;
  choiceHoldMs?: number;
}

export class PaseoBrowserPasskeys {
  private readonly tabs = new Map<number, TabState>();
  private readonly boundSessions = new WeakSet<object>();
  private readonly now: () => Date;
  private readonly log: (message: string, detail?: Record<string, unknown>) => void;
  private nextRequestId = 0;

  public constructor(private readonly options: PasskeyHubOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  public get store(): PasskeyStore {
    return this.options.store;
  }

  /**
   * Delta 102: the session's account picker is where every discoverable passkey request waits.
   * Answered at once only for a request the tab's user started (one stored account); otherwise held
   * (see the top of this file). A credential this app never stored is never chosen.
   */
  public bindSession(session: PasskeySession): void {
    if (this.boundSessions.has(session)) return;
    this.boundSessions.add(session);
    session.on("select-webauthn-account", (_event, details, callback) => {
      let called = false;
      const answer = (credentialId: string | null) => {
        if (called) return;
        called = true;
        callback(credentialId);
      };
      this.handleAccountRequest(details, answer).catch((error: unknown) => {
        this.log("[browser-passkeys] account request failed", { error: String(error) });
        answer(null);
      });
    });
  }

  /** Stored accounts among the ones the authenticator offered, in the order offered. */
  public storedAccounts(accounts: readonly WebAuthnAccountChoice[]): PasskeyRequestAccount[] {
    const result: PasskeyRequestAccount[] = [];
    for (const account of accounts) {
      const stored = this.store.get(toBase64Url(account.credentialId));
      if (!stored) continue;
      const userName = stored.userName || account.name;
      const userDisplayName = stored.userDisplayName || account.displayName;
      result.push({
        credentialId: stored.credentialId,
        ...(userName ? { userName } : {}),
        ...(userDisplayName ? { userDisplayName } : {}),
      });
    }
    return result;
  }

  /** The request a tab waits on (the newest when several frames wait), or null. */
  public waitingRequest(contentsId: number): WaitingPasskeyRequest | null {
    const held = this.tabs.get(contentsId)?.held;
    return held && held.length > 0 ? held[held.length - 1].request : null;
  }

  /** Every `choose_account` request, for a pane that starts watching. */
  public waitingChoices(): WaitingPasskeyRequest[] {
    const choices: WaitingPasskeyRequest[] = [];
    for (const state of this.tabs.values()) {
      for (const entry of state.held) {
        if (waitsInPane(entry.request.reason)) choices.push(entry.request);
      }
    }
    return choices;
  }

  /**
   * Delta 102: an agent asked to sign in with a stored passkey on this tab. `account` names one by
   * credential id, user name, or display name; without it a request with one account is answered
   * and one with several is left waiting for a choice.
   */
  public use(contentsId: number, account?: string): PasskeyUseOutcome {
    const state = this.tabs.get(contentsId);
    const entry = state?.held[state.held.length - 1];
    if (!state || !entry) return { kind: "none" };
    const { accounts } = entry.request;
    const chosen = account === undefined ? undefined : matchAccount(accounts, account);
    if (account !== undefined && !chosen) {
      return { kind: "choose", request: entry.request, unmatchedAccount: account };
    }
    const picked = chosen ?? (accounts.length === 1 ? accounts[0] : undefined);
    if (!picked) return { kind: "choose", request: entry.request };
    this.release(state, entry, picked.credentialId);
    return { kind: "used", request: entry.request, account: picked };
  }

  /**
   * A person answered a `choose_account` request in the tab's pane: an account, or `null` for
   * Cancel (the page gets NotAllowedError, as a browser's Cancel does). False when the request is
   * no longer waiting (an agent answered first, the page left, or the choice expired).
   */
  public answerChoice(contentsId: number, requestId: string, credentialId: string | null): boolean {
    const state = this.tabs.get(contentsId);
    const entry = state?.held.find((held) => held.request.id === requestId);
    if (!state || !entry) return false;
    if (
      credentialId !== null &&
      !entry.request.accounts.some((a) => a.credentialId === credentialId)
    ) {
      return false;
    }
    this.release(state, entry, credentialId);
    return true;
  }

  private async handleAccountRequest(
    details: { relyingPartyId: string; accounts: WebAuthnAccountChoice[]; frame?: unknown },
    answer: (credentialId: string | null) => void,
  ): Promise<void> {
    const accounts = this.storedAccounts(details.accounts);
    const state = this.tabOfFrame(details.frame);
    if (accounts.length === 0 || !state) {
      // Nothing of ours to offer, or a frame outside the browser tabs: the page gets
      // NotAllowedError and takes its other sign-in route.
      answer(null);
      return;
    }
    // One request per frame at a time (Chromium answers a second one "already pending"), so a
    // request this frame still holds was aborted by the page. Answering it is a no-op.
    const frameKey = frameKeyOf(details.frame);
    for (const stale of state.held.filter((held) => held.frameKey === frameKey)) {
      this.release(state, stale, null);
    }
    const activated = await this.hasUserActivation(state);
    // Activation outlives a same-document navigation: a click on a client-side routed "Sign in"
    // link leaves the login view activated for seconds, and its autofill would read as asked for.
    // A click counts as asking only when the tab has not navigated since (read after the
    // activation, so a navigation the request raced with is already recorded).
    const askedFor = activated && state.lastGestureAt > state.lastNavigationAt;
    const reason = requestWait(activated, askedFor, accounts.length);
    this.log("[browser-passkeys] passkey request", {
      contentsId: state.contents.id,
      rpId: details.relyingPartyId,
      accounts: accounts.length,
      activated,
      navigatedSinceGesture: activated && !askedFor,
      decision: reason ?? "answered",
    });
    if (reason === null) {
      this.deliver(answer, accounts[0].credentialId);
      return;
    }
    this.hold(state, { frameKey, rpId: details.relyingPartyId, accounts, reason, answer });
  }

  /** Delta 102: a click Daseo dispatched for an agent (a user-gesture page script). */
  public markGesture(contentsId: number): void {
    const state = this.tabs.get(contentsId);
    if (state) state.lastGestureAt = this.now().getTime();
  }

  private tabOfFrame(frame: unknown): TabState | undefined {
    let contentsId: number | undefined;
    try {
      contentsId = frame ? this.options.contentsIdOfFrame?.(frame) : undefined;
    } catch {
      // A frame that went away throws on access.
      contentsId = undefined;
    }
    return contentsId === undefined ? undefined : this.tabs.get(contentsId);
  }

  /**
   * Whether the tab's page has transient user activation right now. A click or key in any frame
   * activates the main frame too, so the main frame answers for the whole tab. Read in an isolated
   * world: the page's own `navigator` and getters are never called. Sent beside the tab's CDP queue,
   * not through it: the answer is only true for a few seconds after the gesture, and a long command
   * holding the queue would turn every explicit request into a held one. Any failure reads false.
   */
  private async hasUserActivation(state: TabState): Promise<boolean> {
    const { contents } = state;
    if (contents.isDestroyed()) return false;
    const dbg = contents.debugger;
    const read = async (): Promise<boolean> => {
      if (!dbg.isAttached()) dbg.attach("1.3");
      const tree = (await dbg.sendCommand("Page.getFrameTree")) as {
        frameTree?: { frame?: { id?: string } };
      };
      const frameId = tree.frameTree?.frame?.id;
      if (!frameId) return false;
      const world = (await dbg.sendCommand("Page.createIsolatedWorld", {
        frameId,
        worldName: ACTIVATION_WORLD_NAME,
      })) as { executionContextId?: number };
      if (typeof world.executionContextId !== "number") return false;
      const evaluated = (await dbg.sendCommand("Runtime.evaluate", {
        expression: "navigator.userActivation.isActive",
        contextId: world.executionContextId,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      return evaluated.result?.value === true;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ACTIVATION_READ_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      this.log("[browser-passkeys] could not read user activation; the request waits", {
        contentsId: contents.id,
        error: String(error),
      });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private hold(
    state: TabState,
    input: {
      frameKey: string;
      rpId: string;
      accounts: PasskeyRequestAccount[];
      reason: PasskeyRequestWait;
      answer: (credentialId: string | null) => void;
    },
  ): void {
    const since = this.now().getTime();
    const holdMs = this.options.choiceHoldMs ?? PASSKEY_CHOICE_HOLD_MS;
    const request: WaitingPasskeyRequest = {
      id: `passkey-request-${(this.nextRequestId += 1)}`,
      contentsId: state.contents.id,
      rpId: input.rpId,
      accounts: input.accounts,
      reason: input.reason,
      since,
      ...(waitsInPane(input.reason) ? { expiresAt: since + holdMs } : {}),
    };
    const entry: HeldRequest = {
      request,
      frameKey: input.frameKey,
      answer: input.answer,
      timer: null,
    };
    // A request that waits for no gesture stays pending, as a browser leaves passkey autofill
    // pending until the person picks; an explicit request with an open choice times out.
    if (waitsInPane(input.reason)) {
      entry.timer = setTimeout(() => this.release(state, entry, null), holdMs);
    }
    state.held.push(entry);
    if (waitsInPane(input.reason)) choiceSurface?.show(request);
  }

  /** Answers a held request (`null` cancels it) and forgets it. */
  private release(state: TabState, entry: HeldRequest, credentialId: string | null): void {
    const index = state.held.indexOf(entry);
    if (index === -1) return;
    state.held.splice(index, 1);
    if (entry.timer) clearTimeout(entry.timer);
    if (waitsInPane(entry.request.reason)) {
      choiceSurface?.hide(state.contents.id, entry.request.id);
    }
    if (credentialId === null) {
      entry.answer(null);
      return;
    }
    this.deliver(entry.answer, credentialId);
  }

  /** Hands the assertion to the page and records the passkey as used. */
  private deliver(answer: (credentialId: string | null) => void, credentialId: string): void {
    answer(credentialId);
    const touched = this.store.touch(credentialId, 0, this.now().toISOString());
    if (touched) this.log("[browser-passkeys] passkey used", { rpId: touched.rpId });
  }

  /** The page left: every request it held went with it. */
  private dropHeld(state: TabState): void {
    // release() removes the entry, so the list shrinks to empty.
    while (state.held.length > 0) this.release(state, state.held[0], null);
  }

  /** Installs the authenticator now and again after every cross-document navigation. */
  public attach(
    contents: PasskeyTabContents,
    queue: CdpSessionQueue = new CdpSessionQueue(),
  ): void {
    if (this.tabs.has(contents.id)) return;
    const state: TabState = {
      contents,
      queue,
      authenticatorId: null,
      loaded: new Set(),
      discoverable: new Set(),
      generation: 0,
      held: [],
      lastGestureAt: Number.NEGATIVE_INFINITY,
      lastNavigationAt: Number.NEGATIVE_INFINITY,
    };
    this.tabs.set(contents.id, state);
    contents.debugger.on?.("message", (_event, method, params) => {
      this.handleDebuggerMessage(state, method, params);
    });
    contents.debugger.on?.("detach", () => {
      state.authenticatorId = null;
      state.loaded.clear();
      state.discoverable.clear();
    });
    // Deferred past the navigation's other observers: DevTools resets the virtual environment
    // for the new document in the same DidFinishNavigation pass, and an enable sent from inside
    // did-navigate landed before that reset and was wiped (capture harness, 2026-11-02).
    contents.on("did-navigate", () => {
      state.lastNavigationAt = this.now().getTime();
      this.dropHeld(state);
      setTimeout(() => void this.install(state), 0);
    });
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame !== false) state.lastNavigationAt = this.now().getTime();
    });
    contents.on("input-event", (_event, input) => {
      const type = (input as { type?: unknown } | undefined)?.type;
      if (typeof type === "string" && GESTURE_INPUT_TYPES.has(type)) {
        state.lastGestureAt = this.now().getTime();
      }
    });
    contents.on("dom-ready", () => {
      if (state.authenticatorId === null) void this.install(state);
    });
    contents.once("destroyed", () => {
      this.dropHeld(state);
      this.tabs.delete(contents.id);
    });
    void this.install(state);
  }

  public isInstalled(contentsId: number): boolean {
    const state = this.tabs.get(contentsId);
    return state !== undefined && state.authenticatorId !== null;
  }

  /** Waits for a pending install of the tab, for callers that want the truth right now. */
  public async settle(contentsId: number): Promise<void> {
    const state = this.tabs.get(contentsId);
    if (state) await state.queue.run(async () => {}, { label: "passkey install" }).catch(() => {});
  }

  public listInfo(rpIdFilter?: string): BrowserAutomationPasskeyInfo[] {
    return this.store
      .list()
      .filter((passkey) => !rpIdFilter || hostMatchesRpId(rpIdFilter, passkey.rpId))
      .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt))
      .map(toInfo);
  }

  public storage(): BrowserAutomationPasskeysResult["storage"] {
    return { path: this.store.filePath, encrypted: true };
  }

  public async delete(credentialId: string): Promise<boolean> {
    const removed = this.store.remove(credentialId);
    if (!removed) return false;
    await Promise.all(
      [...this.tabs.values()].map((state) =>
        state.queue
          .run(
            async () => {
              if (!state.authenticatorId || !state.loaded.has(credentialId)) return;
              await state.contents.debugger
                .sendCommand("WebAuthn.removeCredential", {
                  authenticatorId: state.authenticatorId,
                  credentialId: fromBase64Url(credentialId),
                })
                .catch(() => undefined);
              state.loaded.delete(credentialId);
              state.discoverable.delete(credentialId);
            },
            { label: "WebAuthn.removeCredential" },
          )
          .catch(() => {
            // A tab whose session did not answer drops the credential at its next install.
          }),
      ),
    );
    return true;
  }

  private async install(state: TabState): Promise<void> {
    const generation = (state.generation += 1);
    await state.queue
      .run(
        async () => {
          if (state.contents.isDestroyed() || generation !== state.generation) return;
          const { debugger: dbg } = state.contents;
          let added: { authenticatorId: string } | null = null;
          try {
            if (!dbg.isAttached()) dbg.attach("1.3");
            await dbg.sendCommand("WebAuthn.enable", { enableUI: false });
            const previous = state.authenticatorId;
            state.authenticatorId = null;
            state.loaded.clear();
            state.discoverable.clear();
            if (previous !== null) {
              // Rejects with "not found" when the navigation already dropped the environment.
              await dbg
                .sendCommand("WebAuthn.removeVirtualAuthenticator", { authenticatorId: previous })
                .catch(() => undefined);
            }
            added = (await dbg.sendCommand("WebAuthn.addVirtualAuthenticator", {
              options: VIRTUAL_AUTHENTICATOR_OPTIONS,
            })) as { authenticatorId: string };
            const loaded = new Set<string>();
            const discoverable = new Set<string>();
            const plan = planTabCredentials(this.store.list(), hostOf(state.contents.getURL()));
            for (const { passkey, discoverable: isDiscoverable } of plan) {
              const privateKey = this.store.keyOf(passkey.credentialId);
              if (privateKey === undefined) continue;
              await dbg.sendCommand("WebAuthn.addCredential", {
                authenticatorId: added.authenticatorId,
                credential: toCdpCredential(passkey, privateKey, isDiscoverable),
              });
              loaded.add(passkey.credentialId);
              if (isDiscoverable) discoverable.add(passkey.credentialId);
            }
            state.authenticatorId = added.authenticatorId;
            state.loaded = loaded;
            state.discoverable = discoverable;
          } catch (error) {
            state.authenticatorId = null;
            state.loaded.clear();
            state.discoverable.clear();
            if (added && !state.contents.isDestroyed()) {
              // A half-loaded authenticator would hold the environment's only internal slot.
              await dbg
                .sendCommand("WebAuthn.removeVirtualAuthenticator", {
                  authenticatorId: added.authenticatorId,
                })
                .catch(() => undefined);
            }
            if (!state.contents.isDestroyed()) {
              this.log("[browser-passkeys] install failed", {
                contentsId: state.contents.id,
                error: String(error),
              });
            }
          }
        },
        { label: "passkey install" },
      )
      .catch((error: unknown) => {
        // The slot outlived its deadline (delta 92); the next navigation installs again.
        state.authenticatorId = null;
        state.loaded.clear();
        state.discoverable.clear();
        this.log("[browser-passkeys] install timed out", {
          contentsId: state.contents.id,
          error: String(error),
        });
      });
  }

  private handleDebuggerMessage(
    state: TabState,
    method: string,
    params: Record<string, unknown> | undefined,
  ): void {
    if (method !== "WebAuthn.credentialAdded" && method !== "WebAuthn.credentialAsserted") return;
    const credential = params?.credential as CdpCredential | undefined;
    if (!credential || typeof credential.credentialId !== "string") return;
    const credentialId = toBase64Url(credential.credentialId);
    const at = this.now().toISOString();
    if (method === "WebAuthn.credentialAdded") {
      this.handleCredentialAdded(state, credentialId, credential, at);
      return;
    }
    // Delta 102: the authenticator signs before the account picker runs, so a held request has a
    // signature nobody used; the counter moves (every tab must sign above it) but `lastUsedAt` is
    // set when the assertion reaches the page (deliver). A credential loaded non-discoverable was
    // named by the site in allowCredentials, which never reaches the picker: it is used now.
    const before = this.store.get(credentialId);
    const usedNow = !state.discoverable.has(credentialId) ? at : undefined;
    const updated = this.store.touch(credentialId, credential.signCount ?? 0, usedNow);
    if (updated && before && updated.signCount !== before.signCount) {
      void this.syncOthers(state, credentialId);
    }
  }

  private handleCredentialAdded(
    state: TabState,
    credentialId: string,
    credential: CdpCredential,
    at: string,
  ): void {
    // Our own addCredential during install echoes here too; only a site's create() is new.
    if (state.loaded.has(credentialId) || this.store.get(credentialId)) return;
    const stored: StoredPasskey = {
      credentialId,
      rpId: credential.rpId ?? hostOf(state.contents.getURL()) ?? "",
      privateKey: credential.privateKey,
      ...(credential.userHandle ? { userHandle: credential.userHandle } : {}),
      ...(credential.userName ? { userName: credential.userName } : {}),
      ...(credential.userDisplayName ? { userDisplayName: credential.userDisplayName } : {}),
      signCount: credential.signCount ?? 0,
      createdAt: at,
      createdOnUrl: state.contents.getURL(),
    };
    if (!this.store.add(stored)) return;
    state.loaded.add(credentialId);
    if (credential.isResidentCredential !== false) state.discoverable.add(credentialId);
    this.log("[browser-passkeys] passkey registered", {
      rpId: stored.rpId,
      userName: stored.userName,
    });
    void this.syncOthers(state, credentialId);
    // The registration took the free slot; loading again demotes the least recently used
    // discoverable credential so the next registration in this tab has a slot too.
    if (state.discoverable.size > DISCOVERABLE_SLOTS) void this.install(state);
  }

  /** Puts the stored copy of one credential into every other installed tab. */
  private async syncOthers(origin: TabState, credentialId: string): Promise<void> {
    const passkey = this.store.get(credentialId);
    const privateKey = this.store.keyOf(credentialId);
    if (!passkey || privateKey === undefined) return;
    await Promise.all(
      [...this.tabs.values()]
        .filter((state) => state !== origin)
        .map((state) =>
          state.queue
            .run(
              async () => {
                if (!state.authenticatorId || state.contents.isDestroyed()) return;
                const { debugger: dbg } = state.contents;
                try {
                  // A credential the tab already holds keeps its role; a new one takes a
                  // discoverable slot only on its own site and only while one is free.
                  const host = hostOf(state.contents.getURL());
                  const isDiscoverable = state.loaded.has(credentialId)
                    ? state.discoverable.has(credentialId)
                    : host !== undefined &&
                      hostMatchesRpId(host, passkey.rpId) &&
                      state.discoverable.size < DISCOVERABLE_SLOTS;
                  if (state.loaded.has(credentialId)) {
                    await dbg.sendCommand("WebAuthn.removeCredential", {
                      authenticatorId: state.authenticatorId,
                      credentialId: fromBase64Url(credentialId),
                    });
                  }
                  await dbg.sendCommand("WebAuthn.addCredential", {
                    authenticatorId: state.authenticatorId,
                    credential: toCdpCredential(passkey, privateKey, isDiscoverable),
                  });
                  state.loaded.add(credentialId);
                  if (isDiscoverable) state.discoverable.add(credentialId);
                } catch (error) {
                  this.log("[browser-passkeys] sync failed", {
                    contentsId: state.contents.id,
                    error: String(error),
                  });
                }
              },
              { label: "passkey sync" },
            )
            .catch((error: unknown) => {
              this.log("[browser-passkeys] sync timed out", {
                contentsId: state.contents.id,
                error: String(error),
              });
            }),
        ),
    );
  }
}

function toInfo(passkey: StoredPasskey): BrowserAutomationPasskeyInfo {
  return {
    credentialId: passkey.credentialId,
    rpId: passkey.rpId,
    ...(passkey.userName ? { userName: passkey.userName } : {}),
    ...(passkey.userDisplayName ? { userDisplayName: passkey.userDisplayName } : {}),
    createdAt: passkey.createdAt,
    ...(passkey.lastUsedAt ? { lastUsedAt: passkey.lastUsedAt } : {}),
    ...(passkey.createdOnUrl ? { createdOnUrl: passkey.createdOnUrl } : {}),
    signCount: passkey.signCount,
  };
}

export function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.hostname
      : undefined;
  } catch {
    return undefined;
  }
}

/** A relying party id covers its own host and every subdomain of it. */
export function hostMatchesRpId(host: string, rpId: string): boolean {
  const h = host.toLowerCase();
  const rp = rpId.toLowerCase();
  return h === rp || h.endsWith(`.${rp}`);
}

/**
 * Delta 102: `null` answers at once (a click or key with no navigation since, and one account).
 * Otherwise why the request waits.
 */
export function requestWait(
  activated: boolean,
  askedFor: boolean,
  accounts: number,
): PasskeyRequestWait | null {
  if (!activated) return "no_gesture";
  if (!askedFor) return "navigated_after_gesture";
  return accounts === 1 ? null : "choose_account";
}

/** Delta 102: an agent's tool click on this tab counts as a gesture (see markGesture). */
export function markPaseoBrowserUserGesture(contentsId: number): void {
  activeHub?.markGesture(contentsId);
}

function frameKeyOf(frame: unknown): string {
  try {
    const id = (frame as { frameTreeNodeId?: unknown } | null | undefined)?.frameTreeNodeId;
    return typeof id === "number" ? String(id) : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * An account named by credential id, or by user name, then display name (case-insensitive). A name
 * two accounts share picks neither.
 */
export function matchAccount(
  accounts: readonly PasskeyRequestAccount[],
  name: string,
): PasskeyRequestAccount | undefined {
  const wanted = name.trim();
  const byId = accounts.find((account) => account.credentialId === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const byUserName = accounts.filter((account) => account.userName?.toLowerCase() === lower);
  if (byUserName.length === 1) return byUserName[0];
  const byDisplayName = accounts.filter(
    (account) => account.userDisplayName?.toLowerCase() === lower,
  );
  return byDisplayName.length === 1 ? byDisplayName[0] : undefined;
}

/**
 * An account name with most of it hidden, for results that list who a request could sign in as:
 * `al•••@example.com`, `ax•••p`. The credential id beside it is what the agent passes back.
 */
export function maskAccountName(name: string | undefined): string {
  if (!name) return "(no name)";
  const at = name.indexOf("@");
  if (at > 0) return `${name.slice(0, Math.min(2, at))}•••${name.slice(at)}`;
  if (name.length <= 3) return `${name.slice(0, 1)}•••`;
  return `${name.slice(0, 2)}•••${name.slice(-1)}`;
}

// Delta 102: the panes that show a `choose_account` request (set by ipc.ts).
let choiceSurface: PasskeyChoiceSurface | null = null;

export function setPaseoBrowserPasskeyChoiceSurface(surface: PasskeyChoiceSurface | null): void {
  choiceSurface = surface;
}

// One hub per app; the automation service reaches it through this accessor so the service
// stays free of Electron imports (the capture harness sets its own).
let activeHub: PaseoBrowserPasskeys | null = null;
let unavailableReason: string | null = null;

export function setPaseoBrowserPasskeys(hub: PaseoBrowserPasskeys | null): void {
  activeHub = hub;
  if (hub) unavailableReason = null;
}

export function getPaseoBrowserPasskeys(): PaseoBrowserPasskeys | null {
  return activeHub;
}

/** Records why this run has no passkeys, so the tool can say it instead of a generic refusal. */
export function setPaseoBrowserPasskeysUnavailable(reason: string): void {
  activeHub = null;
  unavailableReason = reason;
}

export function getPaseoBrowserPasskeysUnavailableReason(): string | null {
  return unavailableReason;
}
