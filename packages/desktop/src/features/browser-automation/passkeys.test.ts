import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CdpSessionQueue } from "./cdp-session-queue.js";
import {
  DISCOVERABLE_SLOTS,
  planTabCredentials,
  PASSKEY_KEY_ENV,
  PaseoBrowserPasskeys,
  PasskeyCipher,
  PasskeyKeyMismatchError,
  PasskeyStore,
  fromBase64Url,
  maskAccountName,
  matchAccount,
  hostMatchesRpId,
  toBase64Url,
  type PasskeyChoiceSurface,
  type PasskeyTabContents,
  type WaitingPasskeyRequest,
  type WebAuthnAccountChoice,
  setPaseoBrowserPasskeyChoiceSurface,
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
  /** What `navigator.userActivation.isActive` reads in the page; `"throw"` fails the read. */
  public activation: boolean | "throw" = false;
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
      if (command === "Page.getFrameTree")
        return { frameTree: { frame: { id: `frame-${this.id}` } } };
      if (command === "Page.createIsolatedWorld") return { executionContextId: 70 + this.id };
      if (command === "Runtime.evaluate") {
        if (this.activation === "throw") throw new Error("Execution context was destroyed");
        return { result: { type: "boolean", value: this.activation } };
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

function hub(store = new PasskeyStore(filePath, cipher), choiceHoldMs?: number) {
  return new PaseoBrowserPasskeys({
    store,
    now: () => clock,
    // The fake frames carry their tab's id, as webContents.fromFrame resolves a real one.
    contentsIdOfFrame: (frame) => (frame as { contentsId?: number }).contentsId,
    ...(choiceHoldMs !== undefined ? { choiceHoldMs } : {}),
  });
}

type AccountListener = (
  event: unknown,
  details: { relyingPartyId: string; accounts: WebAuthnAccountChoice[]; frame?: unknown },
  callback: (credentialId?: string | null) => void,
) => void;

/** A browser profile session whose account picker the test drives like Electron does. */
function fakeSession() {
  let listener: AccountListener | null = null;
  return {
    on: (_event: "select-webauthn-account", next: AccountListener) => {
      listener = next;
    },
    /** One discoverable get() reaching the picker; returns what the page was answered. */
    request(input: {
      accounts: WebAuthnAccountChoice[];
      contentsId: number;
      frameTreeNodeId?: number;
      rpId?: string;
    }) {
      const answers: Array<string | null | undefined> = [];
      listener?.(
        {},
        {
          relyingPartyId: input.rpId ?? "example.com",
          accounts: input.accounts,
          frame: { contentsId: input.contentsId, frameTreeNodeId: input.frameTreeNodeId ?? 1 },
        },
        (id) => answers.push(id),
      );
      return answers;
    },
  };
}

function recordingSurface() {
  const events: string[] = [];
  const surface: PasskeyChoiceSurface = {
    show: (request: WaitingPasskeyRequest) => events.push(`show ${request.id}`),
    hide: (_contentsId: number, requestId: string) => events.push(`hide ${requestId}`),
  };
  return { events, surface };
}

/** Lets the activation read (three CDP round trips) finish. */
async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function storeWithTwoAccounts() {
  const store = new PasskeyStore(filePath, cipher);
  store.add({
    credentialId: "older",
    rpId: "example.com",
    privateKey: "k1",
    userName: "a@example.com",
    signCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: "2026-10-20T00:00:00.000Z",
  });
  store.add({
    credentialId: "newer",
    rpId: "example.com",
    privateKey: "k2",
    userName: "b@example.com",
    userDisplayName: "Bea",
    signCount: 0,
    createdAt: "2026-10-02T00:00:00.000Z",
    lastUsedAt: "2026-10-30T00:00:00.000Z",
  });
  return store;
}

const TWO_ACCOUNTS: WebAuthnAccountChoice[] = [
  { credentialId: "older", name: "a@example.com" },
  { credentialId: "newer", name: "b@example.com" },
  { credentialId: "foreign", name: "c@example.com" },
];

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
  // Delta 94: Chromium's virtual authenticator refuses create() at three discoverable credentials.
  test("a tab holds at most two discoverable credentials, the latest used of its own site", async () => {
    const h = hub();
    const first = new FakeTab(1);
    h.attach(first, new CdpSessionQueue());
    await settle(h, first);
    const register = async (suffix: string, rpId: string) => {
      first.url = `https://${rpId}/`;
      clock = new Date(clock.getTime() + 60_000);
      first.emitDebugger("WebAuthn.credentialAdded", {
        authenticatorId: "auth-1-1",
        credential: {
          ...SITE_CREDENTIAL,
          credentialId: `${suffix}${SITE_CREDENTIAL.credentialId.slice(suffix.length)}`,
          rpId,
        },
      });
      await settle(h, first);
    };
    await register("AAA1", "example.com");
    await register("AAA2", "example.com");
    await register("AAA3", "example.com");
    await register("BBB1", "other.test");
    expect(h.store.list()).toHaveLength(4);

    const plan = planTabCredentials(h.store.list(), "app.example.com");
    expect(
      plan
        .filter((entry) => entry.discoverable)
        .map((entry) => entry.passkey.credentialId.slice(0, 4)),
    ).toEqual(["AAA2", "AAA3"]);
    expect(planTabCredentials(h.store.list(), undefined).some((entry) => entry.discoverable)).toBe(
      false,
    );
    expect(DISCOVERABLE_SLOTS).toBe(2);

    const tab = new FakeTab(2);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    const loaded = tab
      .commandsNamed("WebAuthn.addCredential")
      .map((entry) => entry.params?.credential as Record<string, unknown>);
    expect(loaded).toHaveLength(4);
    const discoverable = loaded.filter((credential) => credential.isResidentCredential === true);
    expect(discoverable.map((credential) => String(credential.credentialId).slice(0, 4))).toEqual([
      "AAA2",
      "AAA3",
    ]);
    for (const credential of loaded.filter((entry) => entry.isResidentCredential === false)) {
      expect(credential).not.toHaveProperty("userHandle");
    }

    // A registration fills the third slot; the tab loads again and is back at two.
    const before = tab.commandsNamed("WebAuthn.addVirtualAuthenticator").length;
    clock = new Date(clock.getTime() + 60_000);
    tab.emitDebugger("WebAuthn.credentialAdded", {
      authenticatorId: "auth-2-1",
      credential: {
        ...SITE_CREDENTIAL,
        credentialId: `AAA4${SITE_CREDENTIAL.credentialId.slice(4)}`,
      },
    });
    await settle(h, tab);
    expect(tab.commandsNamed("WebAuthn.addVirtualAuthenticator").length).toBe(before + 1);
    const reloaded = tab
      .commandsNamed("WebAuthn.addCredential")
      .slice(-5)
      .map((entry) => entry.params?.credential as Record<string, unknown>);
    expect(
      reloaded
        .filter((credential) => credential.isResidentCredential === true)
        .map((credential) => String(credential.credentialId).slice(0, 4))
        .sort(),
    ).toEqual(["AAA3", "AAA4"]);
  });

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

  test("a signature bumps the counter and the other tabs' copies, and lastUsedAt waits for the page to get it", async () => {
    const h = hub();
    const session = fakeSession();
    h.bindSession(session);
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
    // The authenticator signs before the account picker runs (Electron 44 order).
    second.emitDebugger("WebAuthn.credentialAsserted", {
      authenticatorId: "auth-2-1",
      credential: { ...SITE_CREDENTIAL, signCount: 7 },
    });
    await settle(h, first, second);

    expect(h.store.get(SITE_CREDENTIAL_ID_URL)).toMatchObject({ signCount: 7 });
    expect(h.store.get(SITE_CREDENTIAL_ID_URL)?.lastUsedAt).toBeUndefined();
    const removed = first.commandsNamed("WebAuthn.removeCredential");
    const added = first.commandsNamed("WebAuthn.addCredential");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.params).toEqual({
      authenticatorId: "auth-1-1",
      credentialId: SITE_CREDENTIAL.credentialId,
    });
    expect(added.at(-1)?.params?.credential).toMatchObject({ signCount: 7 });

    second.activation = true;
    const answers = session.request({
      contentsId: 2,
      accounts: [{ credentialId: SITE_CREDENTIAL_ID_URL, name: "alice@example.com" }],
    });
    await flush();
    expect(answers).toEqual([SITE_CREDENTIAL_ID_URL]);
    expect(h.listInfo()[0]).toMatchObject({ signCount: 7, lastUsedAt: "2026-11-02T04:00:00.000Z" });
  });

  test("a credential the site named in allowCredentials is used at its signature", async () => {
    const store = new PasskeyStore(filePath, cipher);
    store.add({
      credentialId: "other-site",
      rpId: "other.org",
      privateKey: "k",
      signCount: 2,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const h = hub(store);
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    clock = new Date("2026-11-02T05:00:00.000Z");
    // Loaded non-discoverable (another site's), so only an allowCredentials request reaches it,
    // and such a request never goes through the account picker.
    tab.emitDebugger("WebAuthn.credentialAsserted", {
      authenticatorId: "auth-1-1",
      credential: { credentialId: fromBase64Url("other-site"), signCount: 3 },
    });
    expect(h.store.get("other-site")).toMatchObject({
      signCount: 3,
      lastUsedAt: "2026-11-02T05:00:00.000Z",
    });
  });

  test("a passkey request started with no click or key waits, and use answers it", async () => {
    const h = hub(storeWithTwoAccounts());
    const session = fakeSession();
    h.bindSession(session);
    h.bindSession(session);
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);

    // Passkey autofill on page load: one stored account, no activation.
    const answers = session.request({ contentsId: 1, accounts: [TWO_ACCOUNTS[1]] });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(answers).toEqual([]);
    expect(h.waitingRequest(1)).toMatchObject({
      rpId: "example.com",
      reason: "no_gesture",
      accounts: [{ credentialId: "newer", userName: "b@example.com", userDisplayName: "Bea" }],
    });
    expect(h.waitingRequest(1)).not.toHaveProperty("expiresAt");
    // Read in an isolated world, never in the page's own world.
    const evaluate = tab.commandsNamed("Runtime.evaluate")[0]?.params;
    expect(evaluate).toMatchObject({
      expression: "navigator.userActivation.isActive",
      contextId: 71,
    });
    expect(tab.commandsNamed("Page.createIsolatedWorld")[0]?.params).toMatchObject({
      frameId: "frame-1",
      worldName: "daseo-passkeys",
    });
    expect(h.store.get("newer")?.lastUsedAt).toBe("2026-10-30T00:00:00.000Z");

    expect(h.use(1)).toMatchObject({ kind: "used", account: { credentialId: "newer" } });
    expect(answers).toEqual(["newer"]);
    expect(h.waitingRequest(1)).toBeNull();
    expect(h.store.get("newer")?.lastUsedAt).toBe(clock.toISOString());
    expect(h.use(1)).toEqual({ kind: "none" });
  });

  test("a request the tab's user started signs in at once with the only stored account", async () => {
    const h = hub(storeWithTwoAccounts());
    const session = fakeSession();
    h.bindSession(session);
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    tab.activation = true;
    const answers = session.request({ contentsId: 1, accounts: [TWO_ACCOUNTS[0]] });
    await flush();
    expect(answers).toEqual(["older"]);
    expect(h.waitingRequest(1)).toBeNull();
  });

  test("an unreadable activation leaves the request waiting instead of signing in", async () => {
    const h = hub(storeWithTwoAccounts());
    const session = fakeSession();
    h.bindSession(session);
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    tab.activation = "throw";
    const answers = session.request({ contentsId: 1, accounts: [TWO_ACCOUNTS[0]] });
    await flush();
    expect(answers).toEqual([]);
    expect(h.waitingRequest(1)?.reason).toBe("no_gesture");
  });

  test("two stored accounts: an explicit request waits for a choice, never the most recent one", async () => {
    const { events, surface } = recordingSurface();
    setPaseoBrowserPasskeyChoiceSurface(surface);
    try {
      const h = hub(storeWithTwoAccounts());
      const session = fakeSession();
      h.bindSession(session);
      const tab = new FakeTab(1);
      h.attach(tab, new CdpSessionQueue());
      await settle(h, tab);
      tab.activation = true;
      const answers = session.request({ contentsId: 1, accounts: TWO_ACCOUNTS });
      await flush();
      expect(answers).toEqual([]);
      const waiting = h.waitingRequest(1);
      expect(waiting).toMatchObject({
        reason: "choose_account",
        expiresAt: clock.getTime() + 60_000,
      });
      // The foreign credential is not ours and is never offered.
      expect(waiting?.accounts.map((account) => account.credentialId)).toEqual(["older", "newer"]);
      expect(events).toEqual([`show ${waiting?.id}`]);

      expect(h.use(1)).toMatchObject({ kind: "choose" });
      expect(h.use(1, "nobody@example.com")).toMatchObject({
        kind: "choose",
        unmatchedAccount: "nobody@example.com",
      });
      expect(answers).toEqual([]);
      expect(h.use(1, "BEA")).toMatchObject({ kind: "used", account: { credentialId: "newer" } });
      expect(answers).toEqual(["newer"]);
      expect(events).toEqual([`show ${waiting?.id}`, `hide ${waiting?.id}`]);
      // The pane's late answer finds nothing to answer.
      expect(h.answerChoice(1, waiting?.id ?? "", "older")).toBe(false);
    } finally {
      setPaseoBrowserPasskeyChoiceSurface(null);
    }
  });

  test("the person picks in the pane, Cancel refuses, and an unanswered choice is cancelled", async () => {
    const h = hub(storeWithTwoAccounts(), 40);
    const session = fakeSession();
    h.bindSession(session);
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    tab.activation = true;

    const picked = session.request({ contentsId: 1, accounts: TWO_ACCOUNTS });
    await flush();
    const first = h.waitingRequest(1);
    expect(h.answerChoice(1, first?.id ?? "", "foreign")).toBe(false);
    expect(h.answerChoice(1, first?.id ?? "", "older")).toBe(true);
    expect(picked).toEqual(["older"]);

    const cancelled = session.request({ contentsId: 1, accounts: TWO_ACCOUNTS });
    await flush();
    expect(h.answerChoice(1, h.waitingRequest(1)?.id ?? "", null)).toBe(true);
    expect(cancelled).toEqual([null]);

    const expired = session.request({ contentsId: 1, accounts: TWO_ACCOUNTS });
    await flush();
    expect(h.waitingRequest(1)?.reason).toBe("choose_account");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(expired).toEqual([null]);
    expect(h.waitingRequest(1)).toBeNull();
  });

  test("a newer request from the same frame replaces the held one, and a navigation ends both", async () => {
    const h = hub(storeWithTwoAccounts());
    const session = fakeSession();
    h.bindSession(session);
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);

    const autofill = session.request({ contentsId: 1, accounts: [TWO_ACCOUNTS[0]] });
    await flush();
    const iframe = session.request({
      contentsId: 1,
      frameTreeNodeId: 2,
      accounts: [TWO_ACCOUNTS[1]],
    });
    await flush();
    // The page aborted its autofill request and started another one in the same frame.
    const again = session.request({ contentsId: 1, accounts: [TWO_ACCOUNTS[0]] });
    await flush();
    expect(autofill).toEqual([null]);
    expect(iframe).toEqual([]);
    expect(again).toEqual([]);

    tab.emit("did-navigate");
    expect(iframe).toEqual([null]);
    expect(again).toEqual([null]);
    expect(h.waitingRequest(1)).toBeNull();
    await settle(h, tab);
  });

  test("the site's passkey button after autofill signs in and leaves nothing waiting", async () => {
    const h = hub(storeWithTwoAccounts());
    const session = fakeSession();
    h.bindSession(session);
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    const autofill = session.request({ contentsId: 1, accounts: [TWO_ACCOUNTS[0]] });
    await flush();
    expect(h.waitingRequest(1)?.reason).toBe("no_gesture");
    // The button's click aborts the autofill request and starts a modal one in the same frame.
    tab.activation = true;
    const clicked = session.request({ contentsId: 1, accounts: [TWO_ACCOUNTS[0]] });
    await flush();
    expect(autofill).toEqual([null]);
    expect(clicked).toEqual(["older"]);
    expect(h.waitingRequest(1)).toBeNull();
  });

  test("an account the store never held, or a frame outside the browser tabs, is refused", async () => {
    const h = hub(storeWithTwoAccounts());
    const session = fakeSession();
    h.bindSession(session);
    const tab = new FakeTab(1);
    h.attach(tab, new CdpSessionQueue());
    await settle(h, tab);
    const foreign = session.request({ contentsId: 1, accounts: [TWO_ACCOUNTS[2]] });
    const elsewhere = session.request({ contentsId: 99, accounts: [TWO_ACCOUNTS[0]] });
    await flush();
    expect(foreign).toEqual([null]);
    expect(elsewhere).toEqual([null]);
  });

  test("accounts are named by credential id or name, and listed masked", () => {
    const accounts = [
      { credentialId: "a1", userName: "alice@example.com", userDisplayName: "Alice" },
      { credentialId: "b2", userName: "ax-dfcorp" },
      { credentialId: "c3", userName: "twin-a", userDisplayName: "Twin" },
      { credentialId: "d4", userName: "twin-b", userDisplayName: "Twin" },
    ];
    expect(matchAccount(accounts, "b2")?.userName).toBe("ax-dfcorp");
    expect(matchAccount(accounts, " Alice@Example.com ")?.credentialId).toBe("a1");
    expect(matchAccount(accounts, "alice")?.credentialId).toBe("a1");
    expect(matchAccount(accounts, "TWIN-B")?.credentialId).toBe("d4");
    // Two accounts share the display name: ambiguous, so neither is picked.
    expect(matchAccount(accounts, "Twin")).toBeUndefined();
    expect(matchAccount(accounts, "nobody")).toBeUndefined();
    expect(maskAccountName("alice@example.com")).toBe("al•••@example.com");
    expect(maskAccountName("ax-dfcorp")).toBe("ax•••p");
    expect(maskAccountName("bob")).toBe("b•••");
    expect(maskAccountName(undefined)).toBe("(no name)");
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
