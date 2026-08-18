import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";

import {
  generateKeyPair,
  exportPublicKey,
  exportSecretKey,
  importPublicKey,
  importSecretKey,
  generateSigningKeyPair,
  exportSigningPublicKey,
  exportSigningSecretKey,
  importSigningPublicKey,
  importSigningSecretKey,
  type KeyPair,
  type SigningKeyPair,
} from "@getpaseo/relay/e2ee";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";

const LegacyKeyPairSchema = z.object({
  v: z.literal(2),
  publicKeyB64: z.string().min(1),
  secretKeyB64: z.string().min(1),
});

const KeyPairSchema = z.object({
  v: z.literal(3),
  publicKeyB64: z.string().min(1),
  secretKeyB64: z.string().min(1),
  signingPublicKeyB64: z.string().min(1),
  signingSecretKeyB64: z.string().min(1),
  keyEpoch: z.number().int().positive(),
});

const StoredKeyPairSchema = z.union([LegacyKeyPairSchema, KeyPairSchema]);
type StoredKeyPair = z.infer<typeof KeyPairSchema>;

const KEYPAIR_FILENAME = "daemon-keypair.json";

export interface DaemonKeyPairBundle {
  keyPair: KeyPair;
  publicKeyB64: string;
  signingKeyPair: SigningKeyPair;
  signingPublicKeyB64: string;
  keyEpoch: number;
}

export async function loadOrCreateDaemonKeyPair(
  paseoHome: string,
  logger?: pino.Logger,
): Promise<DaemonKeyPairBundle> {
  const log = logger?.child({ module: "daemon-keypair" });
  const filePath = path.join(paseoHome, KEYPAIR_FILENAME);

  if (existsSync(filePath)) {
    try {
      ensurePrivateFile(filePath);
      const raw = readFileSync(filePath, "utf8");
      const parsed = StoredKeyPairSchema.parse(JSON.parse(raw));

      const publicKey = importPublicKey(parsed.publicKeyB64);
      const secretKey = importSecretKey(parsed.secretKeyB64);
      const publicKeyB64 = exportPublicKey(publicKey);
      const signingKeyPair =
        parsed.v === 3
          ? {
              publicKey: importSigningPublicKey(parsed.signingPublicKeyB64),
              secretKey: importSigningSecretKey(parsed.signingSecretKeyB64),
            }
          : generateSigningKeyPair();
      const signingPublicKeyB64 = exportSigningPublicKey(signingKeyPair.publicKey);
      const keyEpoch = parsed.v === 3 ? parsed.keyEpoch : 1;

      if (parsed.v === 2) {
        const upgraded: StoredKeyPair = {
          v: 3,
          publicKeyB64,
          secretKeyB64: exportSecretKey(secretKey),
          signingPublicKeyB64,
          signingSecretKeyB64: exportSigningSecretKey(signingKeyPair.secretKey),
          keyEpoch,
        };
        writePrivateFileAtomicSync(filePath, `${JSON.stringify(upgraded, null, 2)}\n`);
      }

      log?.info({ filePath, keyEpoch }, "Loaded daemon keypair");
      return {
        keyPair: { publicKey, secretKey },
        publicKeyB64,
        signingKeyPair,
        signingPublicKeyB64,
        keyEpoch,
      };
    } catch (error) {
      log?.warn({ err: error, filePath }, "Failed to load daemon keypair, regenerating");
    }
  }

  const keyPair = generateKeyPair();
  const signingKeyPair = generateSigningKeyPair();
  const publicKeyB64 = exportPublicKey(keyPair.publicKey);
  const secretKeyB64 = exportSecretKey(keyPair.secretKey);
  const signingPublicKeyB64 = exportSigningPublicKey(signingKeyPair.publicKey);
  const keyEpoch = 1;

  const payload: StoredKeyPair = {
    v: 3,
    publicKeyB64,
    secretKeyB64,
    signingPublicKeyB64,
    signingSecretKeyB64: exportSigningSecretKey(signingKeyPair.secretKey),
    keyEpoch,
  };

  writePrivateFileAtomicSync(filePath, JSON.stringify(payload, null, 2) + "\n");
  log?.info({ filePath }, "Saved daemon keypair");

  return {
    keyPair,
    publicKeyB64,
    signingKeyPair,
    signingPublicKeyB64,
    keyEpoch,
  };
}
