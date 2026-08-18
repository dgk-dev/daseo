import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { DevicePairingStore } from "./device-pairing-store.js";

const homes: string[] = [];
const logger = pino({ level: "silent" });

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function createStore(): DevicePairingStore {
  const home = mkdtempSync(join(tmpdir(), "paseo-device-pairing-"));
  homes.push(home);
  return new DevicePairingStore(home, logger);
}

describe("DevicePairingStore", () => {
  test("consumes one grant, then authenticates the same device without the grant", async () => {
    const store = createStore();
    const grant = await store.createGrant({
      now: new Date("2026-08-18T00:00:00.000Z"),
      ttlMs: 60_000,
    });
    await expect(
      store.authorize({
        ...grant,
        deviceId: "device-1",
        signingPublicKeyB64: "device-public-key",
        label: "Fold",
        platform: "android",
        now: new Date("2026-08-18T00:00:10.000Z"),
      }),
    ).resolves.toMatchObject({
      deviceId: "device-1",
      label: "Fold",
      scopes: ["*"],
      revokedAt: null,
    });

    await expect(
      store.authorize({
        deviceId: "device-1",
        signingPublicKeyB64: "device-public-key",
        now: new Date("2026-08-18T00:01:00.000Z"),
      }),
    ).resolves.toMatchObject({ deviceId: "device-1" });
    await expect(
      store.authorize({
        ...grant,
        deviceId: "device-2",
        signingPublicKeyB64: "second-key",
        now: new Date("2026-08-18T00:01:00.000Z"),
      }),
    ).rejects.toThrow("missing, expired, or already used");
  });

  test("rejects expired grants, key replacement, and revoked devices", async () => {
    const store = createStore();
    const expired = await store.createGrant({
      now: new Date("2026-08-18T00:00:00.000Z"),
      ttlMs: 1,
    });
    await expect(
      store.authorize({
        ...expired,
        deviceId: "device-expired",
        signingPublicKeyB64: "key",
        now: new Date("2026-08-18T00:00:01.000Z"),
      }),
    ).rejects.toThrow("missing, expired, or already used");

    const grant = await store.createGrant({ now: new Date("2026-08-18T00:02:00.000Z") });
    await store.authorize({
      ...grant,
      deviceId: "device-1",
      signingPublicKeyB64: "original-key",
      now: new Date("2026-08-18T00:02:01.000Z"),
    });
    await expect(
      store.authorize({ deviceId: "device-1", signingPublicKeyB64: "replacement-key" }),
    ).rejects.toThrow("signing key changed");
    await store.revoke("device-1", new Date("2026-08-18T00:03:00.000Z"));
    await expect(
      store.authorize({ deviceId: "device-1", signingPublicKeyB64: "original-key" }),
    ).rejects.toThrow("revoked");
  });
});
