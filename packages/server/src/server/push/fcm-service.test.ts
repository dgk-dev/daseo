import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { FcmService } from "./fcm-service.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

function createCredentialsFile(directory: string, mode = 0o600): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credentialPath = path.join(directory, "fcm.json");
  writeFileSync(
    credentialPath,
    JSON.stringify({
      project_id: "daseo-test",
      client_email: "sender@daseo-test.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      token_uri: "https://oauth.test/token",
    }),
    { mode },
  );
  return credentialPath;
}

describe("FcmService", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  test("exchanges a signed assertion and sends a high-priority Android notification", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "daseo-fcm-"));
    directories.push(directory);
    const credentialPath = createCredentialsFile(directory);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "message-id" }), { status: 200 }));
    const service = new FcmService(createLogger(), vi.fn(), {
      credentialPath,
      fetch: fetchMock as typeof fetch,
      now: () => Date.parse("2026-08-16T00:00:00Z"),
    });

    await service.sendPush(["fcm:device-token"], {
      title: "Agent finished",
      body: "Done",
      data: { workspaceId: "w1", count: 2 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const oauthBody = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(oauthBody).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://fcm.googleapis.com/v1/projects/daseo-test/messages:send",
    );
    const pushBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(pushBody.message).toMatchObject({
      token: "device-token",
      data: { workspaceId: "w1", count: "2" },
      android: {
        priority: "HIGH",
        notification: { sound: "default", channel_id: "agent-updates" },
      },
    });
  });

  test("coalesces OAuth exchange across a notification fan-out", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "daseo-fcm-"));
    directories.push(directory);
    const credentialPath = createCredentialsFile(directory);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "shared-access", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValue(new Response(JSON.stringify({ name: "message-id" }), { status: 200 }));
    const service = new FcmService(createLogger(), vi.fn(), {
      credentialPath,
      fetch: fetchMock as typeof fetch,
    });

    await service.sendPush(["fcm:device-one", "fcm:device-two"], {
      title: "Finished",
      body: "Done",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => url === "https://oauth.test/token")).toHaveLength(
      1,
    );
  });

  test("revokes an unregistered device token", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "daseo-fcm-"));
    directories.push(directory);
    const credentialPath = createCredentialsFile(directory);
    const revoke = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { status: "UNREGISTERED" } }), {
          status: 404,
        }),
      );
    const service = new FcmService(createLogger(), revoke, {
      credentialPath,
      fetch: fetchMock as typeof fetch,
    });

    await service.sendPush(["fcm:stale-token"], {
      title: "Finished",
      body: "Done",
    });

    expect(revoke).toHaveBeenCalledWith("fcm:stale-token");
  });

  test.skipIf(process.platform === "win32")(
    "refuses a credential file readable by other users",
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "daseo-fcm-"));
      directories.push(directory);
      const credentialPath = createCredentialsFile(directory, 0o644);
      const fetchMock = vi.fn();
      const service = new FcmService(createLogger(), vi.fn(), {
        credentialPath,
        fetch: fetchMock as typeof fetch,
      });

      await service.sendPush(["fcm:device-token"], {
        title: "Finished",
        body: "Done",
      });

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
