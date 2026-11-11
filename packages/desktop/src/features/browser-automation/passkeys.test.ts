import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CdpSessionQueue } from "./cdp-session-queue.js";
import {
  PASSKEY_KEY_ENV,
  PaseoBrowserPasskeys,
  PasskeyCipher,
  PasskeyKeyMismatchError,
  PasskeyStore,
  fromBase64Url,
  hostMatchesRpId,
  toBase64Url,
  type PasskeyTabContents,
  type WebAuthnAccountChoice,
} from "./passkeys.js";

function newCipher(): PasskeyCipher {
  const keyed = PasskeyCipher.fromBase64(randomBytes(32).toString("base64"));
  if (!keyed.ok) throw new Error(keyed.reason);
  return keyed.cipher;
}

// One app key per test file run, like the one 1Password holds for the app.
const cipher = newCipher();

type Listener = (...args: unknown[]) => void;

class FakeTab implements PasskeyTabContents {
  public readonly commands: Array<{ command: string; params?: Record<string, unknown> }> = [];
  public destroyed = false;
  public url = "https://app.example.com/login";
  public failInstall = false;
  private readonly listeners = new Map<string, Listener[]>();
  private readonly debuggerListeners = new Map<string, Listener[]>();
  private attached = false;
  private nextAuthenticator = 1;
  /** Internal authenticators alive in the tab's virtual environment, as Chromium in Electron 44 keeps them across navigations. */
  public readonly liveAuthenticators = new Set<string>();
  public readonly debugger = {
    isAttached: () => this.attached,
    attach: () => {
      this.attached = true;
    },
    sendCommand: async (command: string, params?: Record<string, unknown>) => {
      this.commands.push({ command, params });
      if (this.failInstall && command === "WebAuthn.enable") {
        throw new Error("WebAuthn domain unavailable");
      }
      if (command === "WebAuthn.addVirtualAuthenticator") {
        if (this.liveAuthenticators.size > 0) {
          throw new Error("Chrome only supports one internal authenticator per environment");
        }
        const authenticatorId = `auth-${this.id}-${this.nextAuthenticator++}`;
        this.liveAuthenticators.add(authenticatorId);
        return { authenticatorId };
      }
      if (command === "WebAuthn.removeVirtualAuthenticator") {
        const authenticatorId = String(params?.authenticatorId);
        if (!this.liveAuthenticators.delete(authenticatorId)) {
          throw new Error("Could not find a Virtual Authenticator matching the ID");
        }
      }
      return {};
    },
    on: (event: string, listener: Listener) => {
      const list = this.debuggerListeners.get(event) ?? [];
      list.push(listener);
      this.debuggerListeners.set(event, list);
    },
  };

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public getURL(): string {
    return this.url;
  }

  public on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  public once(event: string, listener: Listener): void {
    this.on(event, listener);
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  public emitDebugger(method: string, params: Record<string, unknown>): void {
    for (const listener of this.debuggerListeners.get("message") ?? []) {
      listener({}, method, params);
    }
  }

  public detachDebugger(): void {
    this.attached = false;
    // Detaching disables the WebAuthn domain, which tears down the virtual environment.
    this.liveAuthenticators.clear();
    for (const listener of this.debuggerListeners.get("detach") ?? []) listener();
  }

  public commandsNamed(command: string) {
    return this.commands.filter((entry) => entry.command === command);
  }
}

// A credential as Chromium reports it from a site's navigator.credentials.create().
const SITE_CREDENTIAL = {
  credentialId: "sPZ3IokjIrg4qoUzz7mCEXfH9NRTc3+DGVL6f9WjGF4=",
  isResidentCredential: true,
  rpId: "example.com",
  privateKey: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg",
  userHandle: "dXNlci0x",
  signCount: 1,
  userName: "alice@example.com",
  userDisplayName: "Alice",
  backupEligibility: true,
  backupState: true,
};
const SITE_CREDENTIAL_ID_URL = "sPZ3IokjIrg4qoUzz7mCEXfH9NRTc3-DGVL6f9WjGF4";

let dir: string;
let filePath: string;
let clock: Date;

function hub(store = new PasskeyStore(filePath, cipher)) {
  return new PaseoBrowserPasskeys({ store, now: () => clock });
}

async function settle(h: PaseoBrowserPasskeys, ...tabs: FakeTab[]) {
  // Navigation installs are deferred by a macrotask.
  await new Promise((resolve) => setTimeout(resolve, 1));
  for (const tab of tabs) await h.settle(tab.id);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "paseo-passkeys-"));
  filePath = path.join(dir, "nested", "browser-passkeys.json");
  clock = new Date("2026-11-02T03:00:00.000Z");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("base64url", () => {
  test("round-trips CDP's standard base64 and the page's base64url form", () => {
    expect(toBase64Url(SITE_CREDENTIAL.credentialId)).toBe(SITE_CREDENTIAL_ID_URL);
    expect(fromBase64Url(SITE_CREDENTIAL_ID_URL)).toBe(SITE_CREDENTIAL.credentialId);
  });

  test("a relying party id covers its host and subdomains only", () => {
    expect(hostMatchesRpId("chatgpt.com", "chatgpt.com")).toBe(true);
    expect(hostMatchesRpId("auth.chatgpt.com", "chatgpt.com")).toBe(true);
    expect(hostMatchesRpId("notchatgpt.com", "chatgpt.com")).toBe(false);
    expect(hostMatchesRpId("chatgpt.com", "auth.chatgpt.com")).toBe(false);
  });
});

describe("PasskeyCipher", () => {
  test("seals and opens a key, and every seal is different", () => {
    const first = cipher.seal(SITE_CREDENTIAL.privateKey);
    const second = cipher.seal(SITE_CREDENTIAL.privateKey);
    expect(first).not.toBe(second);
    expect(first).not.toContain(SITE_CREDENTIAL.privateKey);
    expect(cipher.open(first)).toBe(SITE_CREDENTIAL.privateKey);
  });

  test("another key or an altered text does not open", () => {
    const sealed = cipher.seal(SITE_CREDENTIAL.privateKey);
    expect(() => newCipher().open(sealed)).toThrow();
    const altered = Buffer.from(sealed, "base64");
    altered[altered.length - 1] ^= 1;
    expect(() => cipher.open(altered.toString("base64"))).toThrow();
    expect(() => cipher.open("AAAA")).toThrow("truncated");
  });

  test("a missing or malformed key gives a reason instead of a cipher", () => {
    expect(PasskeyCipher.fromBase64(undefined)).toEqual({
      ok: false,
      reason: `${PASSKEY_KEY_ENV} is not set`,
    });
    expect(PasskeyCipher.fromBase64("  ")).toMatchObject({ ok: false });
    expect(PasskeyCipher.fromBase64(randomBytes(16).toString("base64"))).toEqual({
      ok: false,
      reason: `${PASSKEY_KEY_ENV} is not a base64 32-byte key`,
    });
  });
});

describe("PasskeyStore", () => {
  test("keeps keys sealed on disk and reads them back with the same app key", () => {
    const store = new PasskeyStore(filePath, cipher);
    store.add({
      credentialId: SITE_CREDENTIAL_ID_URL,
      rpId: "example.com",
      privateKey: SITE_CREDENTIAL.privateKey,
      signCount: 0,
      createdAt: clock.toISOString(),
    });
    const onDisk = readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain(SITE_CREDENTIAL.privateKey);
    expect(JSON.parse(onDisk)).toMatchObject({
      version: 2,
      cipher: "aes-256-gcm",
      keyId: cipher.keyId,
    });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(store.list()[0]?.privateKey).toBe("");

    const reopened = new PasskeyStore(filePath, cipher);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.keyOf(SITE_CREDENTIAL_ID_URL)).toBe(SITE_CREDENTIAL.privateKey);
  });

  test("a store sealed with another app key is refused and left untouched", () => {
    new PasskeyStore(filePath, cipher).add({
      credentialId: SITE_CREDENTIAL_ID_URL,
      rpId: "example.com",
      privateKey: SITE_CREDENTIAL.privateKey,
      signCount: 0,
      createdAt: clock.toISOString(),
    });
    const before = readFileSync(filePath, "utf8");
    expect(() => new PasskeyStore(filePath, newCipher())).toThrow(PasskeyKeyMismatchError);
    expect(readFileSync(filePath, "utf8")).toBe(before);
  });

  test("the keychain-sealed store from before is dropped once, without asking for it", () => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        encrypted: true,
        passkeys: [
          {
            credentialId: "meta",
            rpId: "accounts.meta.com",
            privateKey: "djEwAAAA",
            signCount: 0,
            createdAt: "2026-11-09T12:54:18.524Z",
          },
        ],
      }),
    );
    const logged: Array<{ message: string; detail?: Record<string, unknown> }> = [];
    const store = new PasskeyStore(filePath, cipher, (message, detail) =>
      logged.push({ message, ...(detail ? { detail } : {}) }),
    );
    expect(store.list()).toEqual([]);
    expect(logged).toEqual([
      {
        message: "[browser-passkeys] dropped passkeys stored in the keychain-sealed format",
        detail: { count: 1, rpIds: ["accounts.meta.com"] },
      },
    ]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      version: 2,
      cipher: "aes-256-gcm",
      keyId: cipher.keyId,
      passkeys: [],
    });

    logged.length = 0;
    const reopened = new PasskeyStore(filePath, cipher, (message) => logged.push({ message }));
    expect(reopened.list()).toEqual([]);
    expect(logged).toEqual([]);
  });

  test("a damaged entry is skipped for the run and kept on disk", () => {
    const store = new PasskeyStore(filePath, cipher);
    store.add({
      credentialId: "good",
      rpId: "example.com",
      privateKey: "k1",
      signCount: 0,
      createdAt: clock.toISOString(),
    });
    store.add({
      credentialId: "bad",
      rpId: "example.org",
      privateKey: "k2",
      signCount: 0,
      createdAt: clock.toISOString(),
    });
    const file = JSON.parse(readFileSync(filePath, "utf8"));
    file.passkeys[1].privateKey = cipher.seal("x").slice(0, -4) + "AAAA";
    writeFileSync(filePath, JSON.stringify(file));
    const logged: string[] = [];
    const reopened = new PasskeyStore(filePath, cipher, (message) => logged.push(message));
    expect(reopened.list().map((p) => p.credentialId)).toEqual(["good"]);
    expect(logged).toEqual(["[browser-passkeys] skipped a stored passkey that does not decrypt"]);
  });
});

describe("PaseoBrowserPasskeys", () => {
  test("installs a virtual authenticator in a tab and again after every navigation", async () => {
    const h = hub();
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    expect(tab.commands.map((c) => c.command)).toEqual([
      "WebAuthn.enable",
      "WebAuthn.addVirtualAuthenticator",
    ]);
    expect(tab.commands[0]?.params).toEqual({ enableUI: false });
    const options = tab.commands[1]?.params?.options as Record<string, unknown>;
    expect(options).toMatchObject({
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    });
    expect(h.isInstalled(tab.id)).toBe(true);

    tab.emit("did-navigate");
    await settle(h, tab);
    expect(tab.commandsNamed("WebAuthn.addVirtualAuthenticator")).toHaveLength(2);
    expect(h.isInstalled(tab.id)).toBe(true);
  });

  test("a navigation that keeps the environment swaps the authenticator instead of failing", async () => {
    const h = hub();
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    tab.emit("did-navigate");
    await settle(h, tab);
    expect(tab.commandsNamed("WebAuthn.removeVirtualAuthenticator")[0]?.params).toEqual({
      authenticatorId: "auth-1-1",
    });
    expect([...tab.liveAuthenticators]).toEqual(["auth-1-2"]);
    expect(h.isInstalled(tab.id)).toBe(true);
  });

  test("a navigation that dropped the environment still reinstalls", async () => {
    const h = hub();
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    tab.liveAuthenticators.clear();
    tab.emit("did-navigate");
    await settle(h, tab);
    expect([...tab.liveAuthenticators]).toEqual(["auth-1-2"]);
    expect(h.isInstalled(tab.id)).toBe(true);
  });

  test("a half-loaded authenticator is removed so the next install has the slot", async () => {
    const store = new PasskeyStore(filePath, cipher);
    const h = hub(store);
    const first = new FakeTab(1);
    h.attach(first, new CdpSessionQueue());
    await settle(h, first);
    first.emitDebugger("WebAuthn.credentialAdded", {
      authenticatorId: "auth-1-1",
      credential: SITE_CREDENTIAL,
    });
    const tab = new FakeTab(2);
    const send = tab.debugger.sendCommand;
    let failNextCredential = true;
    tab.debugger.sendCommand = async (command, params) => {
      if (command === "WebAuthn.addCredential" && failNextCredential) {
        failNextCredential = false;
        tab.commands.push({ command, params });
        throw new Error("credential rejected");
      }
      return send(command, params);
    };
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    expect(h.isInstalled(tab.id)).toBe(false);
    expect(tab.liveAuthenticators.size).toBe(0);
    tab.emit("did-navigate");
    await settle(h, tab);
    expect(h.isInstalled(tab.id)).toBe(true);
    expect([...tab.liveAuthenticators]).toEqual(["auth-2-2"]);
  });

  test("a passkey a site registers is stored encrypted and served to the other open tab", async () => {
    const h = hub();
    const first = new FakeTab(1);
    const second = new FakeTab(2);
    h.attach(first, new CdpSessionQueue());
    h.attach(second, new CdpSessionQueue());
    await settle(h, first, second);

    first.emitDebugger("WebAuthn.credentialAdded", {
      authenticatorId: "auth-1-1",
      credential: SITE_CREDENTIAL,
    });
    await settle(h, first, second);

    const stored = h.store.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      credentialId: SITE_CREDENTIAL_ID_URL,
      rpId: "example.com",
      userName: "alice@example.com",
      userDisplayName: "Alice",
      userHandle: "dXNlci0x",
      signCount: 1,
      createdAt: "2026-11-02T03:00:00.000Z",
      createdOnUrl: "https://app.example.com/login",
    });
    const onDisk = readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain(SITE_CREDENTIAL.privateKey);
    expect(JSON.parse(onDisk)).toMatchObject({ version: 2, keyId: cipher.keyId });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);

    const synced = second.commandsNamed("WebAuthn.addCredential");
    expect(synced).toHaveLength(1);
    expect(synced[0]?.params).toEqual({
      authenticatorId: "auth-2-1",
      credential: {
        credentialId: SITE_CREDENTIAL.credentialId,
        isResidentCredential: true,
        rpId: "example.com",
        privateKey: SITE_CREDENTIAL.privateKey,
        userHandle: "dXNlci0x",
        signCount: 1,
        userName: "alice@example.com",
        userDisplayName: "Alice",
        backupEligibility: true,
        backupState: true,
      },
    });
    // The install of the registering tab echoes nothing back, and the sync echo is not a new
    // passkey: Chromium reports addCredential through the same event.
    second.emitDebugger("WebAuthn.credentialAdded", {
      authenticatorId: "auth-2-1",
      credential: SITE_CREDENTIAL,
    });
    await settle(h, first, second);
    expect(h.store.list()).toHaveLength(1);
    expect(first.commandsNamed("WebAuthn.addCredential")).toHaveLength(0);
  });

  test("a new tab and a reopened app load the stored passkey with its private key", async () => {
    const h = hub();
    const first = new FakeTab(1);
    h.attach(first, new CdpSessionQueue());
    await settle(h, first);
    first.emitDebugger("WebAuthn.credentialAdded", {
      authenticatorId: "auth-1-1",
      credential: SITE_CREDENTIAL,
    });
    await settle(h, first);

    const later = new FakeTab(3);
    h.attach(later, new CdpSessionQueue());
    await settle(h, later);
    expect(later.commands.map((c) => c.command)).toEqual([
      "WebAuthn.enable",
      "WebAuthn.addVirtualAuthenticator",
      "WebAuthn.addCredential",
    ]);
    expect(later.commands[2]?.params?.credential).toMatchObject({
      privateKey: SITE_CREDENTIAL.privateKey,
    });

    const reopened = hub(new PasskeyStore(filePath, cipher));
    const fresh = new FakeTab(4);
    reopened.attach(fresh, new CdpSessionQueue());
    await settle(reopened, fresh);
    expect(fresh.commands[2]?.params?.credential).toMatchObject({
      credentialId: SITE_CREDENTIAL.credentialId,
      privateKey: SITE_CREDENTIAL.privateKey,
    });
  });

  test("a sign-in bumps the counter and the other tabs' copies so no tab signs with a stale count", async () => {
    const h = hub();
    const first = new FakeTab(1);
    const second = new FakeTab(2);
    h.attach(first, new CdpSessionQueue());
    h.attach(second, new CdpSessionQueue());
    await settle(h, first, second);
    first.emitDebugger("WebAuthn.credentialAdded", {
      authenticatorId: "auth-1-1",
      credential: SITE_CREDENTIAL,
    });
    await settle(h, first, second);

    clock = new Date("2026-11-02T04:00:00.000Z");
    second.emitDebugger("WebAuthn.credentialAsserted", {
      authenticatorId: "auth-2-1",
      credential: { ...SITE_CREDENTIAL, signCount: 7 },
    });
    await settle(h, first, second);

    expect(h.store.get(SITE_CREDENTIAL_ID_URL)).toMatchObject({
      signCount: 7,
      lastUsedAt: "2026-11-02T04:00:00.000Z",
    });
    const removed = first.commandsNamed("WebAuthn.removeCredential");
    const added = first.commandsNamed("WebAuthn.addCredential");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.params).toEqual({
      authenticatorId: "auth-1-1",
      credentialId: SITE_CREDENTIAL.credentialId,
    });
    expect(added.at(-1)?.params?.credential).toMatchObject({ signCount: 7 });
    expect(h.listInfo()[0]).toMatchObject({ signCount: 7, lastUsedAt: "2026-11-02T04:00:00.000Z" });
  });

  test("the account picker answers with the stored passkey used most recently, never an unknown one", async () => {
    const store = new PasskeyStore(filePath, cipher);
    store.add({
      credentialId: "older",
      rpId: "example.com",
      privateKey: "k1",
      signCount: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      lastUsedAt: "2026-10-20T00:00:00.000Z",
    });
    store.add({
      credentialId: "newer",
      rpId: "example.com",
      privateKey: "k2",
      signCount: 0,
      createdAt: "2026-10-02T00:00:00.000Z",
      lastUsedAt: "2026-10-30T00:00:00.000Z",
    });
    const h = hub(store);
    const accounts: WebAuthnAccountChoice[] = [
      { credentialId: "older", name: "a@example.com" },
      { credentialId: "newer", name: "b@example.com" },
      { credentialId: "foreign", name: "c@example.com" },
    ];
    expect(h.chooseAccount(accounts)).toBe("newer");
    expect(h.chooseAccount([{ credentialId: "foreign" }])).toBeNull();

    const answers: Array<string | null | undefined> = [];
    const session = {
      on: (
        _event: "select-webauthn-account",
        listener: (
          event: unknown,
          details: { relyingPartyId: string; accounts: WebAuthnAccountChoice[] },
          callback: (credentialId?: string | null) => void,
        ) => void,
      ) => {
        listener({}, { relyingPartyId: "example.com", accounts }, (id) => answers.push(id));
        listener({}, { relyingPartyId: "example.com", accounts: [] }, (id) => answers.push(id));
      },
    };
    h.bindSession(session);
    h.bindSession(session);
    expect(answers).toEqual(["newer", null]);
  });

  test("delete removes the passkey from the store and from every open tab", async () => {
    const h = hub();
    const first = new FakeTab(1);
    const second = new FakeTab(2);
    h.attach(first, new CdpSessionQueue());
    h.attach(second, new CdpSessionQueue());
    await settle(h, first, second);
    first.emitDebugger("WebAuthn.credentialAdded", {
      authenticatorId: "auth-1-1",
      credential: SITE_CREDENTIAL,
    });
    await settle(h, first, second);

    expect(await h.delete("missing")).toBe(false);
    expect(await h.delete(SITE_CREDENTIAL_ID_URL)).toBe(true);
    expect(h.store.list()).toHaveLength(0);
    for (const tab of [first, second]) {
      expect(tab.commandsNamed("WebAuthn.removeCredential")).toHaveLength(1);
    }
    const next = new FakeTab(3);
    h.attach(next, new CdpSessionQueue());
    await settle(h, next);
    expect(next.commandsNamed("WebAuthn.addCredential")).toHaveLength(0);
  });

  test("a failed install is reported as not installed and retried on the next navigation", async () => {
    const h = hub();
    const tab = new FakeTab(1);
    tab.failInstall = true;
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    expect(h.isInstalled(tab.id)).toBe(false);

    tab.failInstall = false;
    tab.emit("did-navigate");
    await settle(h, tab);
    expect(h.isInstalled(tab.id)).toBe(true);

    tab.detachDebugger();
    expect(h.isInstalled(tab.id)).toBe(false);
    tab.emit("dom-ready");
    await settle(h, tab);
    expect(h.isInstalled(tab.id)).toBe(true);
    const installs = tab.commandsNamed("WebAuthn.addVirtualAuthenticator").length;
    tab.emit("dom-ready");
    await settle(h, tab);
    expect(tab.commandsNamed("WebAuthn.addVirtualAuthenticator")).toHaveLength(installs);
  });

  test("status filters stored passkeys by the tab's host", async () => {
    const store = new PasskeyStore(filePath, cipher);
    store.add({
      credentialId: "one",
      rpId: "chatgpt.com",
      privateKey: "k",
      signCount: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    store.add({
      credentialId: "two",
      rpId: "google.com",
      privateKey: "k",
      signCount: 0,
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    const h = hub(store);
    expect(h.listInfo("auth.chatgpt.com").map((p) => p.credentialId)).toEqual(["one"]);
    expect(h.listInfo().map((p) => p.credentialId)).toEqual(["two", "one"]);
    expect(h.storage()).toEqual({ path: filePath, encrypted: true });
    expect(h.listInfo()[0]).not.toHaveProperty("privateKey");
  });
});
