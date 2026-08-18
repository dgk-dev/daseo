import * as SecureStore from "expo-secure-store";
import {
  exportSigningPublicKey,
  exportSigningSecretKey,
  generateSigningKeyPair,
  importSigningPublicKey,
  importSigningSecretKey,
  type SigningKeyPair,
} from "@getpaseo/relay/e2ee";

const STORAGE_KEY = "paseo.device-signing-identity";

export interface DeviceSigningIdentity {
  deviceId: string;
  keyPair: SigningKeyPair;
}

interface PersistedDeviceSigningIdentity {
  version: 1;
  deviceId: string;
  publicKeyB64: string;
  secretKeyB64: string;
}

function parseIdentity(raw: string | null): DeviceSigningIdentity | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedDeviceSigningIdentity>;
    if (
      parsed.version !== 1 ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.publicKeyB64 !== "string" ||
      typeof parsed.secretKeyB64 !== "string"
    ) {
      return null;
    }
    return {
      deviceId: parsed.deviceId,
      keyPair: {
        publicKey: importSigningPublicKey(parsed.publicKeyB64),
        secretKey: importSigningSecretKey(parsed.secretKeyB64),
      },
    };
  } catch {
    return null;
  }
}

export async function getOrCreateDeviceSigningIdentity(): Promise<DeviceSigningIdentity> {
  const existing = parseIdentity(await SecureStore.getItemAsync(STORAGE_KEY));
  if (existing) return existing;
  const keyPair = generateSigningKeyPair();
  const identity: DeviceSigningIdentity = { deviceId: crypto.randomUUID(), keyPair };
  await SecureStore.setItemAsync(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      deviceId: identity.deviceId,
      publicKeyB64: exportSigningPublicKey(keyPair.publicKey),
      secretKeyB64: exportSigningSecretKey(keyPair.secretKey),
    } satisfies PersistedDeviceSigningIdentity),
  );
  return identity;
}
