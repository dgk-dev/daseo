import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "./atomic-file.js";

const PairingGrantSchema = z.object({
  offerId: z.string().min(1),
  secretHash: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
});

const PairedDeviceSchema = z.object({
  deviceId: z.string().min(1),
  signingPublicKeyB64: z.string().min(1),
  label: z.string().nullable(),
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
  scopes: z.array(z.string().min(1)).min(1),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});

const DevicePairingFileSchema = z.object({
  version: z.literal(1),
  grants: z.array(PairingGrantSchema),
  devices: z.array(PairedDeviceSchema),
});

export type PairedDevice = z.infer<typeof PairedDeviceSchema>;
export const DEFAULT_PAIRED_DEVICE_SCOPES = ["mobile"] as const;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export class DevicePairingStore {
  private readonly filePath: string;
  private readonly logger: Logger | null;
  private grants = new Map<string, z.infer<typeof PairingGrantSchema>>();
  private devices = new Map<string, PairedDevice>();
  private hydration: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(paseoHome: string, logger?: Logger) {
    this.filePath = join(paseoHome, "device-pairings.json");
    this.logger = logger?.child({ component: "device-pairings" }) ?? null;
  }

  async createGrant(input?: { now?: Date; ttlMs?: number }): Promise<{
    offerId: string;
    pairingSecret: string;
    expiresAt: string;
  }> {
    return await this.mutate(async () => {
      const now = input?.now ?? new Date();
      const pairingSecret = randomBytes(32).toString("base64url");
      const grant = {
        offerId: randomUUID(),
        secretHash: hashSecret(pairingSecret),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + (input?.ttlMs ?? 10 * 60_000)).toISOString(),
        consumedAt: null,
      };
      this.grants.set(grant.offerId, grant);
      await this.persist(now);
      return { offerId: grant.offerId, pairingSecret, expiresAt: grant.expiresAt };
    });
  }

  async authorize(input: {
    offerId?: string;
    pairingSecret?: string;
    deviceId: string;
    signingPublicKeyB64: string;
    label?: string | null;
    platform?: string | null;
    appVersion?: string | null;
    now?: Date;
  }): Promise<PairedDevice> {
    return await this.mutate(async () => {
      const now = input.now ?? new Date();
      const existing = this.devices.get(input.deviceId);
      if (existing) {
        if (existing.revokedAt) throw new Error("Paired device has been revoked");
        if (existing.signingPublicKeyB64 !== input.signingPublicKeyB64) {
          throw new Error("Paired device signing key changed");
        }
        const updated: PairedDevice = {
          ...existing,
          lastSeenAt: now.toISOString(),
          label: input.label ?? existing.label,
          platform: input.platform ?? existing.platform,
          appVersion: input.appVersion ?? existing.appVersion,
        };
        this.devices.set(updated.deviceId, updated);
        await this.persist(now);
        return updated;
      }

      if (!input.offerId || !input.pairingSecret) {
        throw new Error("New device requires an active pairing grant");
      }
      const grant = this.grants.get(input.offerId);
      if (!grant || grant.consumedAt || Date.parse(grant.expiresAt) <= now.getTime()) {
        throw new Error("Pairing grant is missing, expired, or already used");
      }
      if (!secretMatches(input.pairingSecret, grant.secretHash)) {
        throw new Error("Pairing grant secret is invalid");
      }

      const timestamp = now.toISOString();
      const device: PairedDevice = {
        deviceId: input.deviceId,
        signingPublicKeyB64: input.signingPublicKeyB64,
        label: input.label?.trim() || null,
        platform: input.platform?.trim() || null,
        appVersion: input.appVersion?.trim() || null,
        scopes: [...DEFAULT_PAIRED_DEVICE_SCOPES],
        createdAt: timestamp,
        lastSeenAt: timestamp,
        revokedAt: null,
      };
      this.devices.set(device.deviceId, device);
      this.grants.set(grant.offerId, { ...grant, consumedAt: timestamp });
      await this.persist(now);
      return device;
    });
  }

  async listDevices(): Promise<PairedDevice[]> {
    await this.load();
    return [...this.devices.values()].sort((left, right) =>
      right.lastSeenAt.localeCompare(left.lastSeenAt),
    );
  }

  async revoke(
    deviceId: string,
    now = new Date(),
    beforeCommit?: (deviceId: string) => void,
  ): Promise<PairedDevice | null> {
    return await this.mutate(async () => {
      const existing = this.devices.get(deviceId);
      if (!existing) return null;
      beforeCommit?.(deviceId);
      const updated = { ...existing, revokedAt: now.toISOString() };
      this.devices.set(deviceId, updated);
      await this.persist(now);
      return updated;
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.load();
    const previous = this.mutationTail;
    const run = (async () => {
      await previous;
      return await operation();
    })();
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  private async load(): Promise<void> {
    if (!this.hydration) this.hydration = this.loadFromDisk();
    await this.hydration;
  }

  private async loadFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = DevicePairingFileSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      this.logger?.warn({ issues: parsed.error.issues }, "Ignoring invalid device pairing store");
      return;
    }
    this.grants = new Map(parsed.data.grants.map((grant) => [grant.offerId, grant]));
    let migratedWildcardScopes = false;
    this.devices = new Map(
      parsed.data.devices.map((device) => {
        if (!device.scopes.includes("*")) return [device.deviceId, device];
        migratedWildcardScopes = true;
        const migrated = { ...device, scopes: [...DEFAULT_PAIRED_DEVICE_SCOPES] };
        return [migrated.deviceId, migrated];
      }),
    );
    if (migratedWildcardScopes) await this.persist(new Date());
  }

  private async persist(now: Date): Promise<void> {
    const expiredBefore = now.getTime() - 24 * 60 * 60_000;
    for (const [offerId, grant] of this.grants) {
      if (Date.parse(grant.expiresAt) < expiredBefore) this.grants.delete(offerId);
    }
    await writeJsonFileAtomic(this.filePath, {
      version: 1,
      grants: [...this.grants.values()],
      devices: [...this.devices.values()],
    });
  }
}

const stores = new Map<string, DevicePairingStore>();

export function getDevicePairingStore(paseoHome: string, logger?: Logger): DevicePairingStore {
  const existing = stores.get(paseoHome);
  if (existing) return existing;
  const store = new DevicePairingStore(paseoHome, logger);
  stores.set(paseoHome, store);
  return store;
}
