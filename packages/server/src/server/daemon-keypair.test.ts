import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { PRIVATE_FILE_MODE } from "./private-files.js";
import { exportPublicKey, exportSecretKey, generateKeyPair } from "@getpaseo/relay/e2ee";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function createTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-keypair-"));
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe.skipIf(process.platform === "win32")("daemon keypair file permissions", () => {
  test("creates daemon-keypair.json with private permissions", async () => {
    const home = createTempHome();
    try {
      await loadOrCreateDaemonKeyPair(home);

      expect(modeOf(path.join(home, "daemon-keypair.json"))).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("upgrades a v2 identity without changing its legacy public key", async () => {
    const home = createTempHome();
    const keypairPath = path.join(home, "daemon-keypair.json");
    try {
      const legacy = generateKeyPair();
      const legacyPublicKey = exportPublicKey(legacy.publicKey);
      writeFileSync(
        keypairPath,
        JSON.stringify({
          v: 2,
          publicKeyB64: legacyPublicKey,
          secretKeyB64: exportSecretKey(legacy.secretKey),
        }),
        { mode: PRIVATE_FILE_MODE },
      );

      const upgraded = await loadOrCreateDaemonKeyPair(home);
      const persisted = JSON.parse(readFileSync(keypairPath, "utf8")) as Record<string, unknown>;

      expect(upgraded.publicKeyB64).toBe(legacyPublicKey);
      expect(upgraded.signingPublicKeyB64).toEqual(expect.any(String));
      expect(persisted).toMatchObject({
        v: 3,
        publicKeyB64: legacyPublicKey,
        signingPublicKeyB64: upgraded.signingPublicKeyB64,
        keyEpoch: 1,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs existing daemon-keypair.json permissions when loading", async () => {
    const home = createTempHome();
    const keypairPath = path.join(home, "daemon-keypair.json");
    try {
      const created = await loadOrCreateDaemonKeyPair(home);
      chmodSync(keypairPath, PERMISSIVE_FILE_MODE);

      const loaded = await loadOrCreateDaemonKeyPair(home);

      expect(loaded.publicKeyB64).toBe(created.publicKeyB64);
      expect(modeOf(keypairPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
