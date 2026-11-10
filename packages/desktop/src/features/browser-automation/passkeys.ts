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

export interface StoredPasskey {
  /** base64url without padding, equal to PublicKeyCredential.id on the page. */
  credentialId: string;
  rpId: string;
  /**
   * PKCS#8 private key, base64; encrypted at rest when the store has a cipher. Empty in the
   * copies `PasskeyStore.list()` and `get()` return: the key comes from `keyOf`.
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
  version: 1;
  encrypted: boolean;
  passkeys: StoredPasskey[];
}

/**
 * The subset of Electron's safeStorage the store needs: only the asynchronous API. Its key
 * comes from the macOS keychain on a worker thread (Chromium's KeychainKeyProvider), so a
 * keychain prompt waits there. The synchronous encryptString/decryptString read the keychain on
 * the main thread: after the 0.5.105 swap one such call waited on a keychain prompt for 85+
 * minutes inside a tab install and every main-process browser command timed out (delta 92).
 * Both APIs share the "v10" format and key, so the async one reads what the sync one wrote.
 */
export interface PasskeyCipher {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
}

export type PasskeyLog = (message: string, detail?: Record<string, unknown>) => void;

export class PasskeyStore {
  private readonly file: StoreFile;
  /**
   * Whether `file.encrypted` is settled: true once the file was read from disk or the cipher
   * was asked. The cipher may raise a keychain prompt; asked at startup it kept the app from
   * opening a window (0.5.88 never activated). So it is asked only when a passkey is added or
   * the storage mode is reported, never from the constructor.
   */
  private encryptionSettled: boolean;
  /** Plain private keys (base64) for this app run. Main process memory only; never logged. */
  private readonly keys = new Map<string, string>();
  /** Credential ids added this run whose key is not sealed yet; they are not written. */
  private readonly sealing = new Set<string>();
  private readonly pendingSeals = new Set<Promise<void>>();
  private keysLoading: Promise<void> | null = null;
  private readonly decryptFailures = new Set<string>();

  public constructor(
    public readonly filePath: string,
    private readonly cipher: PasskeyCipher | null,
    private readonly log: PasskeyLog = () => {},
  ) {
    const loaded = this.read();
    this.file = loaded.file;
    this.encryptionSettled = loaded.fromDisk;
    if (!this.file.encrypted) {
      for (const passkey of this.file.passkeys)
        this.keys.set(passkey.credentialId, passkey.privateKey);
    }
  }

  /** Whether keys rest encrypted (or will, once the first passkey is added). */
  public async isEncrypted(): Promise<boolean> {
    await this.settleEncryption();
    return this.file.encrypted;
  }

  /** Records without private keys; use `keyOf` for the key. */
  public list(): StoredPasskey[] {
    return this.file.passkeys.map(publicCopy);
  }

  public get(credentialId: string): StoredPasskey | undefined {
    const found = this.file.passkeys.find((passkey) => passkey.credentialId === credentialId);
    return found ? publicCopy(found) : undefined;
  }

  /** The private key as CDP expects it (plain base64), when it is decrypted already. */
  public keyOf(credentialId: string): string | undefined {
    return this.keys.get(credentialId);
  }

  /** Whether every stored passkey's key is decrypted. */
  public get keysReady(): boolean {
    return this.file.passkeys.every((passkey) => this.keys.has(passkey.credentialId));
  }

  /**
   * Decrypts the stored keys that are not decrypted yet. One run at a time; a failure is logged
   * and the next call tries again. Never await this on a path that serves a command: a keychain
   * prompt holds it until someone answers on the Mac.
   */
  public loadKeys(): Promise<void> {
    if (this.keysReady) return Promise.resolve();
    this.keysLoading ??= this.decryptMissing().finally(() => {
      this.keysLoading = null;
    });
    return this.keysLoading;
  }

  /** Adds a passkey; returns false when one with that credential id already exists. */
  public add(passkey: StoredPasskey): boolean {
    if (this.file.passkeys.some((existing) => existing.credentialId === passkey.credentialId)) {
      return false;
    }
    this.keys.set(passkey.credentialId, passkey.privateKey);
    this.sealing.add(passkey.credentialId);
    this.file.passkeys.push({ ...passkey, privateKey: "" });
    const seal = this.seal(passkey.credentialId, passkey.privateKey);
    this.pendingSeals.add(seal);
    void seal.finally(() => this.pendingSeals.delete(seal));
    return true;
  }

  /** Resolves when every passkey added so far is sealed and written (or failed to be). */
  public async whenPersisted(): Promise<void> {
    while (this.pendingSeals.size > 0) await Promise.all(this.pendingSeals);
  }

  public touch(credentialId: string, signCount: number, usedAt: string): StoredPasskey | undefined {
    const passkey = this.file.passkeys.find((existing) => existing.credentialId === credentialId);
    if (!passkey) return undefined;
    passkey.signCount = Math.max(passkey.signCount, signCount);
    passkey.lastUsedAt = usedAt;
    this.write();
    return publicCopy(passkey);
  }

  public remove(credentialId: string): boolean {
    const before = this.file.passkeys.length;
    this.file.passkeys = this.file.passkeys.filter((p) => p.credentialId !== credentialId);
    if (this.file.passkeys.length === before) return false;
    this.keys.delete(credentialId);
    this.sealing.delete(credentialId);
    this.write();
    return true;
  }

  private async seal(credentialId: string, plainBase64: string): Promise<void> {
    try {
      const encrypted = await this.isEncrypted();
      let sealed = plainBase64;
      if (encrypted) {
        if (!this.cipher) throw new Error("passkey store is encrypted but no cipher is available");
        sealed = (await this.cipher.encryptStringAsync(plainBase64)).toString("base64");
      }
      const record = this.file.passkeys.find((p) => p.credentialId === credentialId);
      if (!record || !this.sealing.has(credentialId)) return;
      record.privateKey = sealed;
      this.sealing.delete(credentialId);
      this.write();
    } catch (error) {
      // Kept in memory for this run; never written in plain text to an encrypted store.
      this.log("[browser-passkeys] could not encrypt a new passkey; it is not saved", {
        error: String(error),
      });
    }
  }

  private async decryptMissing(): Promise<void> {
    const missing = this.file.passkeys.filter(
      (passkey) => !this.keys.has(passkey.credentialId) && !this.sealing.has(passkey.credentialId),
    );
    if (missing.length === 0) return;
    if (!this.cipher) {
      this.log("[browser-passkeys] store is encrypted but no cipher is available");
      return;
    }
    const cipher = this.cipher;
    let reEncrypted = false;
    await Promise.all(
      missing.map(async (passkey) => {
        const sealed = passkey.privateKey;
        try {
          const { result, shouldReEncrypt } = await cipher.decryptStringAsync(
            Buffer.from(sealed, "base64"),
          );
          if (!this.file.passkeys.includes(passkey) || passkey.privateKey !== sealed) return;
          this.keys.set(passkey.credentialId, result);
          if (shouldReEncrypt) {
            passkey.privateKey = (await cipher.encryptStringAsync(result)).toString("base64");
            reEncrypted = true;
          }
        } catch (error) {
          // Retried on the next install; logged once per passkey so navigations do not repeat it.
          if (this.decryptFailures.has(passkey.credentialId)) return;
          this.decryptFailures.add(passkey.credentialId);
          this.log("[browser-passkeys] could not decrypt a stored passkey", {
            rpId: passkey.rpId,
            error: String(error),
          });
        }
      }),
    );
    if (reEncrypted) this.write();
  }

  private async settleEncryption(): Promise<void> {
    if (this.encryptionSettled) return;
    const available = (await this.cipher?.isAsyncEncryptionAvailable().catch(() => false)) === true;
    if (this.encryptionSettled) return;
    this.file.encrypted = available;
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
    const file: StoreFile = {
      ...this.file,
      passkeys: this.file.passkeys.filter((passkey) => !this.sealing.has(passkey.credentialId)),
    };
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
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
  private keysLoading: Promise<void> | null = null;

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

  /**
   * Resolves when stored keys are decrypted and added to the installed tabs. Tests and the
   * capture harness only; no command waits on it.
   */
  public async whenKeysLoaded(): Promise<void> {
    while (this.keysLoading) await this.keysLoading;
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

  public async storage(): Promise<BrowserAutomationPasskeysResult["storage"]> {
    return { path: this.store.filePath, encrypted: await this.store.isEncrypted() };
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
      let added: { authenticatorId: string } | null = null;
      try {
        if (!dbg.isAttached()) dbg.attach("1.3");
        await dbg.sendCommand("WebAuthn.enable", { enableUI: false });
        const previous = state.authenticatorId;
        state.authenticatorId = null;
        state.loaded.clear();
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
        // Only keys decrypted already: the install never waits on the keychain. The rest are
        // added to this tab by `loadMissingKeys` once they are decrypted.
        for (const passkey of this.store.list()) {
          const privateKey = this.store.keyOf(passkey.credentialId);
          if (privateKey === undefined) continue;
          await dbg.sendCommand("WebAuthn.addCredential", {
            authenticatorId: added.authenticatorId,
            credential: toCdpCredential(passkey, privateKey),
          });
          loaded.add(passkey.credentialId);
        }
        state.authenticatorId = added.authenticatorId;
        state.loaded = loaded;
        if (!this.store.keysReady) void this.loadMissingKeys();
      } catch (error) {
        state.authenticatorId = null;
        state.loaded.clear();
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

  /**
   * Decrypts the stored keys off every command path, then adds each newly available
   * credential to every installed tab that lacks it. Started by an install that found keys
   * missing; a keychain prompt holds only this, never a tab install or a command.
   */
  private loadMissingKeys(): Promise<void> {
    this.keysLoading ??= (async () => {
      try {
        await this.store.loadKeys();
        await Promise.all(
          [...this.tabs.values()].map((state) =>
            state.queue.run(async () => {
              if (!state.authenticatorId || state.contents.isDestroyed()) return;
              for (const passkey of this.store.list()) {
                if (state.loaded.has(passkey.credentialId)) continue;
                const privateKey = this.store.keyOf(passkey.credentialId);
                if (privateKey === undefined) continue;
                try {
                  await state.contents.debugger.sendCommand("WebAuthn.addCredential", {
                    authenticatorId: state.authenticatorId,
                    credential: toCdpCredential(passkey, privateKey),
                  });
                  state.loaded.add(passkey.credentialId);
                } catch (error) {
                  this.log("[browser-passkeys] adding a decrypted passkey failed", {
                    contentsId: state.contents.id,
                    error: String(error),
                  });
                }
              }
            }),
          ),
        );
      } finally {
        this.keysLoading = null;
      }
    })();
    return this.keysLoading;
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
                credential: toCdpCredential(passkey, privateKey),
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
