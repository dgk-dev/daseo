import { createSign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pino from "pino";

import type { PushPayload } from "./index.js";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN_SKEW_MS = 60_000;

interface ServiceAccountCredentials {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedAccessToken {
  value: string;
  expiresAt: number;
}

export interface FcmServiceOptions {
  credentialPath?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function stringifyData(data: Record<string, unknown> | undefined): Record<string, string> {
  if (!data) return {};
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
}

function isInvalidDevice(response: Response, responseBody: string): boolean {
  return (
    response.status === 404 ||
    responseBody.includes("UNREGISTERED") ||
    responseBody.includes("registration-token-not-registered") ||
    responseBody.includes("not a valid FCM registration token")
  );
}

/** Direct FCM HTTP v1 sender used by Daseo builds without an Expo project. */
export class FcmService {
  private readonly logger: pino.Logger;
  private readonly revokeToken: (token: string) => void;
  private readonly credentialPath: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private credentialsPromise: Promise<ServiceAccountCredentials | null> | null = null;
  private accessToken: CachedAccessToken | null = null;
  private accessTokenPromise: Promise<string> | null = null;
  private warnedMissingCredentials = false;

  constructor(
    logger: pino.Logger,
    revokeToken: (token: string) => void,
    options = {} as FcmServiceOptions,
  ) {
    this.logger = logger.child({ component: "fcm-service" });
    this.revokeToken = revokeToken;
    this.credentialPath =
      options.credentialPath ??
      process.env.PASEO_FCM_SERVICE_ACCOUNT_FILE ??
      path.join(os.homedir(), ".paseo", "daseo-fcm-service-account.json");
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async sendPush(registeredTokens: string[], payload: PushPayload): Promise<void> {
    if (registeredTokens.length === 0) return;
    const credentials = await this.getCredentials();
    if (!credentials) {
      if (!this.warnedMissingCredentials) {
        this.warnedMissingCredentials = true;
        this.logger.warn(
          { credentialPath: this.credentialPath },
          "FCM credentials unavailable; direct push notifications are disabled",
        );
      }
      return;
    }
    await Promise.all(
      registeredTokens.map((registeredToken) =>
        this.sendOne(credentials, registeredToken, payload, true),
      ),
    );
  }

  private async getCredentials(): Promise<ServiceAccountCredentials | null> {
    this.credentialsPromise ??= this.loadCredentials();
    return this.credentialsPromise;
  }

  private async loadCredentials(): Promise<ServiceAccountCredentials | null> {
    try {
      const fileStat = await stat(this.credentialPath);
      if ((fileStat.mode & 0o077) !== 0) {
        this.logger.error(
          { credentialPath: this.credentialPath },
          "Refusing FCM credentials readable by group or others",
        );
        return null;
      }
      const raw = JSON.parse(
        await readFile(this.credentialPath, "utf8"),
      ) as Partial<ServiceAccountCredentials>;
      if (!raw.project_id || !raw.client_email || !raw.private_key) {
        this.logger.error("FCM service account file is missing required fields");
        return null;
      }
      return raw as ServiceAccountCredentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.error({ err: error }, "Failed to load FCM service account");
      }
      return null;
    }
  }

  private async getAccessToken(credentials: ServiceAccountCredentials): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > this.now()) return this.accessToken.value;
    if (this.accessTokenPromise) return this.accessTokenPromise;
    this.accessTokenPromise = this.fetchAccessToken(credentials);
    try {
      return await this.accessTokenPromise;
    } finally {
      this.accessTokenPromise = null;
    }
  }

  private async fetchAccessToken(credentials: ServiceAccountCredentials): Promise<string> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const tokenUri = credentials.token_uri ?? DEFAULT_TOKEN_URI;
    const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = encodeBase64Url(
      JSON.stringify({
        iss: credentials.client_email,
        scope: FCM_SCOPE,
        aud: tokenUri,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      }),
    );
    const unsigned = `${header}.${claims}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    const assertion = `${unsigned}.${signer.sign(credentials.private_key, "base64url")}`;
    const response = await this.fetchFn(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) throw new Error(`FCM OAuth failed (${response.status})`);
    const body = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new Error("FCM OAuth response omitted access_token");
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.accessToken = {
      value: body.access_token,
      expiresAt: this.now() + expiresIn * 1000 - ACCESS_TOKEN_SKEW_MS,
    };
    return body.access_token;
  }

  private async sendOne(
    credentials: ServiceAccountCredentials,
    registeredToken: string,
    payload: PushPayload,
    retryAuth: boolean,
  ): Promise<void> {
    const deviceToken = registeredToken.slice("fcm:".length).trim();
    if (!deviceToken) {
      this.revokeToken(registeredToken);
      return;
    }
    try {
      const accessToken = await this.getAccessToken(credentials);
      const response = await this.fetchFn(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
          credentials.project_id,
        )}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: deviceToken,
              notification: { title: payload.title, body: payload.body },
              data: stringifyData(payload.data),
              android: {
                priority: "HIGH",
                notification: { sound: "default", channel_id: "agent-updates" },
              },
            },
          }),
        },
      );
      if (response.ok) return;
      const responseBody = await response.text();
      if (response.status === 401 && retryAuth) {
        if (this.accessToken?.value === accessToken) this.accessToken = null;
        await this.sendOne(credentials, registeredToken, payload, false);
        return;
      }
      if (isInvalidDevice(response, responseBody)) this.revokeToken(registeredToken);
      this.logger.error(
        { status: response.status, statusText: response.statusText },
        "FCM push request failed",
      );
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send FCM push notification");
    }
  }
}
