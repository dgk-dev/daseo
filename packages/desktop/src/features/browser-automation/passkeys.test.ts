import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CdpSessionQueue } from "./cdp-session-queue.js";
import {
  PaseoBrowserPasskeys,
  PasskeyStore,
  fromBase64Url,
  hostMatchesRpId,
  toBase64Url,
  type PasskeyCipher,
  type PasskeyTabContents,
  type WebAuthnAccountChoice,
} from "./passkeys.js";

// Reversible stand-in for Electron's async safeStorage; tests check the file never holds the key.
const cipher: PasskeyCipher = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (plain) => Buffer.from(`sealed:${plain}`, "utf8"),
  decryptStringAsync: async (sealed) => ({
    shouldReEncrypt: false,
    result: sealed.toString("utf8").replace(/^sealed:/, ""),
  }),
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  await h.whenKeysLoaded();
  await h.store.whenPersisted();
  for (const tab of tabs) await h.settle(tab.id);
}

/** A store on disk holding SITE_CREDENTIAL, sealed by the reversible cipher. */
async function seedStoredPasskey(): Promise<void> {
  const store = new PasskeyStore(filePath, cipher);
  store.add({
    credentialId: SITE_CREDENTIAL_ID_URL,
    rpId: "example.com",
    privateKey: SITE_CREDENTIAL.privateKey,
    userName: "alice@example.com",
    signCount: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  await store.whenPersisted();
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

describe("PasskeyStore", () => {
  test("opening the store and listing passkeys never asks the keychain-backed cipher", async () => {
    let asked = 0;
    const countingCipher: PasskeyCipher = {
      isAsyncEncryptionAvailable: async () => {
        asked += 1;
        return true;
      },
      encryptStringAsync: async (plain) => {
        asked += 1;
        return cipher.encryptStringAsync(plain);
      },
      decryptStringAsync: async (sealed) => {
        asked += 1;
        return cipher.decryptStringAsync(sealed);
      },
    };
    const store = new PasskeyStore(filePath, countingCipher);
    expect(store.list()).toEqual([]);
    expect(asked).toBe(0);

    store.add({
      credentialId: SITE_CREDENTIAL_ID_URL,
      rpId: "example.com",
      privateKey: SITE_CREDENTIAL.privateKey,
      signCount: 0,
      createdAt: clock.toISOString(),
    });
    await store.whenPersisted();
    expect(asked).toBe(2);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ encrypted: true });

    const reopened = new PasskeyStore(filePath, countingCipher);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0]?.privateKey).toBe("");
    expect(asked).toBe(2);
    expect(await reopened.isEncrypted()).toBe(true);
    expect(asked).toBe(2);
  });

  test("a stored key is decrypted with the async cipher and re-encrypted when it asks", async () => {
    await seedStoredPasskey();
    const before = JSON.parse(readFileSync(filePath, "utf8")).passkeys[0].privateKey;
    const rotating: PasskeyCipher = {
      ...cipher,
      encryptStringAsync: async (plain) => Buffer.from(`sealed2:${plain}`, "utf8"),
      decryptStringAsync: async (sealed) => ({
        shouldReEncrypt: true,
        result: sealed.toString("utf8").replace(/^sealed:/, ""),
      }),
    };
    const store = new PasskeyStore(filePath, rotating);
    expect(store.keyOf(SITE_CREDENTIAL_ID_URL)).toBeUndefined();
    await store.loadKeys();
    expect(store.keyOf(SITE_CREDENTIAL_ID_URL)).toBe(SITE_CREDENTIAL.privateKey);
    const after = JSON.parse(readFileSync(filePath, "utf8")).passkeys[0].privateKey;
    expect(after).not.toBe(before);
    expect(Buffer.from(after, "base64").toString("utf8")).toBe(
      `sealed2:${SITE_CREDENTIAL.privateKey}`,
    );
  });

  test("a new passkey waiting to be encrypted is usable at once and never written in plain text", async () => {
    const sealed = deferred<Buffer>();
    const slow: PasskeyCipher = { ...cipher, encryptStringAsync: () => sealed.promise };
    const store = new PasskeyStore(filePath, slow);
    store.add({
      credentialId: SITE_CREDENTIAL_ID_URL,
      rpId: "example.com",
      privateKey: SITE_CREDENTIAL.privateKey,
      signCount: 0,
      createdAt: clock.toISOString(),
    });
    expect(store.get(SITE_CREDENTIAL_ID_URL)).toMatchObject({ rpId: "example.com" });
    expect(store.keyOf(SITE_CREDENTIAL_ID_URL)).toBe(SITE_CREDENTIAL.privateKey);
    store.touch(SITE_CREDENTIAL_ID_URL, 3, clock.toISOString());
    expect(readFileSync(filePath, "utf8")).not.toContain(SITE_CREDENTIAL.privateKey);
    expect(JSON.parse(readFileSync(filePath, "utf8")).passkeys).toEqual([]);

    sealed.resolve(Buffer.from(`sealed:${SITE_CREDENTIAL.privateKey}`, "utf8"));
    await store.whenPersisted();
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    expect(onDisk.passkeys).toHaveLength(1);
    expect(onDisk.passkeys[0]).toMatchObject({ signCount: 3 });
    expect(readFileSync(filePath, "utf8")).not.toContain(SITE_CREDENTIAL.privateKey);
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
    expect(JSON.parse(onDisk)).toMatchObject({ version: 1, encrypted: true });
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

    await h.store.whenPersisted();
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
    expect(await h.storage()).toEqual({ path: filePath, encrypted: true });
    expect(h.listInfo()[0]).not.toHaveProperty("privateKey");
  });

  test("a tab install never waits on a keychain decrypt that does not answer", async () => {
    await seedStoredPasskey();
    const decrypted = deferred<{ shouldReEncrypt: boolean; result: string }>();
    let decryptCalls = 0;
    const hanging: PasskeyCipher = {
      ...cipher,
      decryptStringAsync: () => {
        decryptCalls += 1;
        return decrypted.promise;
      },
    };
    const h = hub(new PasskeyStore(filePath, hanging));
    const first = new FakeTab(1);
    const second = new FakeTab(2);
    const firstQueue = new CdpSessionQueue();
    h.attach(first, firstQueue);
    h.attach(second, new CdpSessionQueue());
    await new Promise((resolve) => setTimeout(resolve, 1));
    await h.settle(first.id);
    await h.settle(second.id);

    // Both installs finished with an empty authenticator; one decrypt is in flight.
    expect(h.isInstalled(first.id)).toBe(true);
    expect(h.isInstalled(second.id)).toBe(true);
    expect(first.commandsNamed("WebAuthn.addCredential")).toHaveLength(0);
    expect(decryptCalls).toBe(1);
    // Other work on the tab's CDP queue is not held behind the decrypt.
    await expect(firstQueue.run(async () => "screenshot")).resolves.toBe("screenshot");
    // A navigation reinstalls without starting a second decrypt or waiting.
    first.emit("did-navigate");
    await new Promise((resolve) => setTimeout(resolve, 1));
    await h.settle(first.id);
    expect(h.isInstalled(first.id)).toBe(true);
    expect(decryptCalls).toBe(1);

    decrypted.resolve({ shouldReEncrypt: false, result: SITE_CREDENTIAL.privateKey });
    await h.whenKeysLoaded();
    for (const tab of [first, second]) {
      const added = tab.commandsNamed("WebAuthn.addCredential");
      expect(added).toHaveLength(1);
      expect(added[0]?.params).toMatchObject({
        authenticatorId: tab === first ? "auth-1-2" : "auth-2-1",
        credential: {
          credentialId: SITE_CREDENTIAL.credentialId,
          privateKey: SITE_CREDENTIAL.privateKey,
        },
      });
    }
    // A later tab gets the key during its own install.
    const third = new FakeTab(3);
    h.attach(third, new CdpSessionQueue());
    await settle(h, third);
    expect(third.commands.map((c) => c.command)).toEqual([
      "WebAuthn.enable",
      "WebAuthn.addVirtualAuthenticator",
      "WebAuthn.addCredential",
    ]);
  });

  test("a failed decrypt leaves tabs installed without the passkey and the next install retries", async () => {
    await seedStoredPasskey();
    let fail = true;
    const logged: string[] = [];
    const flaky: PasskeyCipher = {
      ...cipher,
      decryptStringAsync: async (sealed) => {
        if (fail) throw new Error("safeStorage.decryptStringAsync is temporarily unavailable");
        return cipher.decryptStringAsync(sealed);
      },
    };
    const store = new PasskeyStore(filePath, flaky, (message) => logged.push(message));
    const h = hub(store);
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    expect(h.isInstalled(tab.id)).toBe(true);
    expect(tab.commandsNamed("WebAuthn.addCredential")).toHaveLength(0);
    expect(logged).toEqual(["[browser-passkeys] could not decrypt a stored passkey"]);

    fail = false;
    tab.emit("did-navigate");
    await settle(h, tab);
    expect(tab.commandsNamed("WebAuthn.addCredential")).toHaveLength(1);
  });

  test("a site's new passkey reaches the other tabs before its encryption finishes", async () => {
    const sealed = deferred<Buffer>();
    const h = hub(
      new PasskeyStore(filePath, { ...cipher, encryptStringAsync: () => sealed.promise }),
    );
    const first = new FakeTab(1);
    const second = new FakeTab(2);
    h.attach(first, new CdpSessionQueue());
    h.attach(second, new CdpSessionQueue());
    await new Promise((resolve) => setTimeout(resolve, 1));
    await h.settle(first.id);
    await h.settle(second.id);
    first.emitDebugger("WebAuthn.credentialAdded", {
      authenticatorId: "auth-1-1",
      credential: SITE_CREDENTIAL,
    });
    await h.settle(second.id);
    expect(second.commandsNamed("WebAuthn.addCredential")[0]?.params?.credential).toMatchObject({
      privateKey: SITE_CREDENTIAL.privateKey,
    });
    expect(h.chooseAccount([{ credentialId: SITE_CREDENTIAL_ID_URL }])).toBe(
      SITE_CREDENTIAL_ID_URL,
    );
    sealed.resolve(Buffer.from(`sealed:${SITE_CREDENTIAL.privateKey}`, "utf8"));
    await h.store.whenPersisted();
    expect(JSON.parse(readFileSync(filePath, "utf8")).passkeys).toHaveLength(1);
  });
});
