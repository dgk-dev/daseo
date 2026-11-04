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
// Chromium drops the virtual authenticator environment on every cross-document navigation
// (measured), so the installer re-runs on each main-frame commit. A discoverable-credential
// get() needs the session's select-webauthn-account answer, otherwise Electron cancels it.

export interface StoredPasskey {
  /** base64url without padding, equal to PublicKeyCredential.id on the page. */
  credentialId: string;
  rpId: string;
  /** PKCS#8 private key, base64; encrypted at rest when the store has a cipher. */
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
  version: 1;
  encrypted: boolean;
  passkeys: StoredPasskey[];
}

/** The subset of Electron's safeStorage the store needs. */
export interface PasskeyCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class PasskeyStore {
  private readonly file: StoreFile;
  /**
   * Whether `file.encrypted` is settled: true once the file was read from disk or the cipher
   * was asked. The cipher is Electron's safeStorage, whose first call reaches the macOS
   * keychain synchronously on the main thread and can wait on a keychain prompt; asked at
   * startup it kept the app from opening a window (0.5.88 never activated). So it is asked only
   * when a passkey is added or the storage mode is reported, never from the constructor.
   */
  private encryptionSettled: boolean;

  public constructor(
    public readonly filePath: string,
    private readonly cipher: PasskeyCipher | null,
  ) {
    const loaded = this.read();
    this.file = loaded.file;
    this.encryptionSettled = loaded.fromDisk;
  }

  public get isEncrypted(): boolean {
    this.settleEncryption();
    return this.file.encrypted;
  }

  public list(): StoredPasskey[] {
    return this.file.passkeys.map((passkey) => ({ ...passkey }));
  }

  public get(credentialId: string): StoredPasskey | undefined {
    const found = this.file.passkeys.find((passkey) => passkey.credentialId === credentialId);
    return found ? { ...found } : undefined;
  }

  /** The private key as CDP expects it (plain base64). */
  public privateKeyOf(passkey: StoredPasskey): string {
    if (!this.file.encrypted) return passkey.privateKey;
    if (!this.cipher) throw new Error("passkey store is encrypted but no cipher is available");
    return this.cipher.decryptString(Buffer.from(passkey.privateKey, "base64"));
  }

  /** Adds a passkey; returns false when one with that credential id already exists. */
  public add(passkey: StoredPasskey): boolean {
    if (this.file.passkeys.some((existing) => existing.credentialId === passkey.credentialId)) {
      return false;
    }
    this.settleEncryption();
    const stored: StoredPasskey = { ...passkey, privateKey: this.sealKey(passkey.privateKey) };
    this.file.passkeys.push(stored);
    this.write();
    return true;
  }

  public touch(credentialId: string, signCount: number, usedAt: string): StoredPasskey | undefined {
    const passkey = this.file.passkeys.find((existing) => existing.credentialId === credentialId);
    if (!passkey) return undefined;
    passkey.signCount = Math.max(passkey.signCount, signCount);
    passkey.lastUsedAt = usedAt;
    this.write();
    return { ...passkey };
  }

  public remove(credentialId: string): boolean {
    const before = this.file.passkeys.length;
    this.file.passkeys = this.file.passkeys.filter((p) => p.credentialId !== credentialId);
    if (this.file.passkeys.length === before) return false;
    this.write();
    return true;
  }

  private sealKey(plainBase64: string): string {
    if (!this.file.encrypted) return plainBase64;
    if (!this.cipher) throw new Error("passkey store is encrypted but no cipher is available");
    return this.cipher.encryptString(plainBase64).toString("base64");
  }

  private settleEncryption(): void {
    if (this.encryptionSettled) return;
    this.file.encrypted = this.cipher?.isEncryptionAvailable() === true;
    this.encryptionSettled = true;
  }

  private read(): { file: StoreFile; fromDisk: boolean } {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreFile>;
      if (parsed.version === 1 && Array.isArray(parsed.passkeys)) {
        return {
          file: {
            version: 1,
            encrypted: parsed.encrypted === true,
            passkeys: parsed.passkeys.filter(isStoredPasskey),
          },
          fromDisk: true,
        };
      }
    } catch {
      // Missing or unreadable: start empty. An unreadable file is never overwritten with
      // an empty one until a passkey is added, and then the write is atomic.
    }
    return { file: { version: 1, encrypted: false, passkeys: [] }, fromDisk: false };
  }

  private write(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }
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

function toCdpCredential(passkey: StoredPasskey, privateKey: string): CdpCredential {
  return {
    credentialId: fromBase64Url(passkey.credentialId),
    isResidentCredential: true,
    rpId: passkey.rpId,
    privateKey,
    ...(passkey.userHandle ? { userHandle: passkey.userHandle } : {}),
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
  on(event: "did-navigate" | "dom-ready", listener: (...args: unknown[]) => void): unknown;
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
      details: { relyingPartyId: string; accounts: WebAuthnAccountChoice[] },
      callback: (credentialId?: string | null) => void,
    ) => void,
  ): unknown;
}

interface TabState {
  contents: PasskeyTabContents;
  queue: CdpSessionQueue;
  authenticatorId: string | null;
  /** Credential ids (base64url) currently loaded into this tab's authenticator. */
  loaded: Set<string>;
  /** Increments per install so a stale install cannot overwrite a newer one. */
  generation: number;
}

export interface PasskeyHubOptions {
  store: PasskeyStore;
  now?: () => Date;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export class PaseoBrowserPasskeys {
  private readonly tabs = new Map<number, TabState>();
  private readonly boundSessions = new WeakSet<object>();
  private readonly now: () => Date;
  private readonly log: (message: string, detail?: Record<string, unknown>) => void;

  public constructor(private readonly options: PasskeyHubOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  public get store(): PasskeyStore {
    return this.options.store;
  }

  /**
   * Answers the session's account picker: the stored passkey used most recently wins; a
   * credential this app never stored is never chosen.
   */
  public bindSession(session: PasskeySession): void {
    if (this.boundSessions.has(session)) return;
    this.boundSessions.add(session);
    session.on("select-webauthn-account", (_event, details, callback) => {
      let chosen: string | null = null;
      try {
        chosen = this.chooseAccount(details.accounts);
      } finally {
        callback(chosen);
      }
    });
  }

  public chooseAccount(accounts: WebAuthnAccountChoice[]): string | null {
    let best: { credentialId: string; lastUsedAt: string } | null = null;
    for (const account of accounts) {
      const stored = this.store.get(toBase64Url(account.credentialId));
      if (!stored) continue;
      const lastUsedAt = stored.lastUsedAt ?? stored.createdAt;
      if (!best || lastUsedAt > best.lastUsedAt) {
        best = { credentialId: account.credentialId, lastUsedAt };
      }
    }
    return best?.credentialId ?? null;
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
      generation: 0,
    };
    this.tabs.set(contents.id, state);
    contents.debugger.on?.("message", (_event, method, params) => {
      this.handleDebuggerMessage(state, method, params);
    });
    contents.debugger.on?.("detach", () => {
      state.authenticatorId = null;
      state.loaded.clear();
    });
    // Deferred past the navigation's other observers: DevTools resets the virtual environment
    // for the new document in the same DidFinishNavigation pass, and an enable sent from inside
    // did-navigate landed before that reset and was wiped (capture harness, 2026-11-02).
    contents.on("did-navigate", () => {
      setTimeout(() => void this.install(state), 0);
    });
    contents.on("dom-ready", () => {
      if (state.authenticatorId === null) void this.install(state);
    });
    contents.once("destroyed", () => {
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
    if (state) await state.queue.run(async () => {});
  }

  public listInfo(rpIdFilter?: string): BrowserAutomationPasskeyInfo[] {
    return this.store
      .list()
      .filter((passkey) => !rpIdFilter || hostMatchesRpId(rpIdFilter, passkey.rpId))
      .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt))
      .map(toInfo);
  }

  public storage(): BrowserAutomationPasskeysResult["storage"] {
    return { path: this.store.filePath, encrypted: this.store.isEncrypted };
  }

  public async delete(credentialId: string): Promise<boolean> {
    const removed = this.store.remove(credentialId);
    if (!removed) return false;
    await Promise.all(
      [...this.tabs.values()].map((state) =>
        state.queue.run(async () => {
          if (!state.authenticatorId || !state.loaded.has(credentialId)) return;
          await state.contents.debugger
            .sendCommand("WebAuthn.removeCredential", {
              authenticatorId: state.authenticatorId,
              credentialId: fromBase64Url(credentialId),
            })
            .catch(() => undefined);
          state.loaded.delete(credentialId);
        }),
      ),
    );
    return true;
  }

  private async install(state: TabState): Promise<void> {
    const generation = (state.generation += 1);
    await state.queue.run(async () => {
      if (state.contents.isDestroyed() || generation !== state.generation) return;
      const { debugger: dbg } = state.contents;
      try {
        if (!dbg.isAttached()) dbg.attach("1.3");
        await dbg.sendCommand("WebAuthn.enable", { enableUI: false });
        const added = (await dbg.sendCommand("WebAuthn.addVirtualAuthenticator", {
          options: VIRTUAL_AUTHENTICATOR_OPTIONS,
        })) as { authenticatorId: string };
        state.authenticatorId = added.authenticatorId;
        state.loaded.clear();
        for (const passkey of this.store.list()) {
          await dbg.sendCommand("WebAuthn.addCredential", {
            authenticatorId: added.authenticatorId,
            credential: toCdpCredential(passkey, this.store.privateKeyOf(passkey)),
          });
          state.loaded.add(passkey.credentialId);
        }
      } catch (error) {
        state.authenticatorId = null;
        state.loaded.clear();
        if (!state.contents.isDestroyed()) {
          this.log("[browser-passkeys] install failed", {
            contentsId: state.contents.id,
            error: String(error),
          });
        }
      }
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
      this.log("[browser-passkeys] passkey registered", {
        rpId: stored.rpId,
        userName: stored.userName,
      });
      void this.syncOthers(state, credentialId);
      return;
    }
    const updated = this.store.touch(credentialId, credential.signCount ?? 0, at);
    if (updated) void this.syncOthers(state, credentialId);
  }

  /** Puts the stored copy of one credential into every other installed tab. */
  private async syncOthers(origin: TabState, credentialId: string): Promise<void> {
    const passkey = this.store.get(credentialId);
    if (!passkey) return;
    await Promise.all(
      [...this.tabs.values()]
        .filter((state) => state !== origin)
        .map((state) =>
          state.queue.run(async () => {
            if (!state.authenticatorId || state.contents.isDestroyed()) return;
            const { debugger: dbg } = state.contents;
            try {
              if (state.loaded.has(credentialId)) {
                await dbg.sendCommand("WebAuthn.removeCredential", {
                  authenticatorId: state.authenticatorId,
                  credentialId: fromBase64Url(credentialId),
                });
              }
              await dbg.sendCommand("WebAuthn.addCredential", {
                authenticatorId: state.authenticatorId,
                credential: toCdpCredential(passkey, this.store.privateKeyOf(passkey)),
              });
              state.loaded.add(credentialId);
            } catch (error) {
              this.log("[browser-passkeys] sync failed", {
                contentsId: state.contents.id,
                error: String(error),
              });
            }
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

// One hub per app; the automation service reaches it through this accessor so the service
// stays free of Electron imports (the capture harness sets its own).
let activeHub: PaseoBrowserPasskeys | null = null;

export function setPaseoBrowserPasskeys(hub: PaseoBrowserPasskeys | null): void {
  activeHub = hub;
}

export function getPaseoBrowserPasskeys(): PaseoBrowserPasskeys | null {
  return activeHub;
}
