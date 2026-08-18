import { describe, expect, test } from "vitest";
import { generateKeyPair, deriveSharedKey } from "./crypto";
import { decryptE2EEV2Frame, deriveE2EEV2SessionKeys, encryptE2EEV2Frame } from "./e2ee-v2";

describe("E2EE v2", () => {
  test("derives matching directional keys and preserves text/binary frame kind", () => {
    const client = generateKeyPair();
    const daemon = generateKeyPair();
    const clientShared = deriveSharedKey(client.secretKey, daemon.publicKey);
    const daemonShared = deriveSharedKey(daemon.secretKey, client.publicKey);
    const transcript = '{"offerId":"offer-1","client":"a","daemon":"b"}';
    const clientKeys = deriveE2EEV2SessionKeys(clientShared, transcript);
    const daemonKeys = deriveE2EEV2SessionKeys(daemonShared, transcript);
    expect(clientKeys).toEqual(daemonKeys);
    expect(clientKeys.clientToDaemonKey).not.toEqual(clientKeys.daemonToClientKey);

    const textFrame = encryptE2EEV2Frame({
      key: clientKeys.clientToDaemonKey,
      noncePrefix: clientKeys.noncePrefix,
      counter: 1n,
      data: "hello",
    });
    expect(
      decryptE2EEV2Frame({
        key: daemonKeys.clientToDaemonKey,
        noncePrefix: daemonKeys.noncePrefix,
        expectedCounter: 1n,
        data: textFrame,
      }).data,
    ).toBe("hello");

    const binary = Uint8Array.of(0, 255, 1).buffer;
    const binaryFrame = encryptE2EEV2Frame({
      key: daemonKeys.daemonToClientKey,
      noncePrefix: daemonKeys.noncePrefix,
      counter: 1n,
      data: binary,
    });
    expect(
      new Uint8Array(
        decryptE2EEV2Frame({
          key: clientKeys.daemonToClientKey,
          noncePrefix: clientKeys.noncePrefix,
          expectedCounter: 1n,
          data: binaryFrame,
        }).data as ArrayBuffer,
      ),
    ).toEqual(new Uint8Array(binary));
  });

  test("rejects replay, gaps, wrong direction, and header tampering", () => {
    const shared = new Uint8Array(32).fill(7);
    const keys = deriveE2EEV2SessionKeys(shared, "transcript");
    const frame = encryptE2EEV2Frame({
      key: keys.clientToDaemonKey,
      noncePrefix: keys.noncePrefix,
      counter: 1n,
      data: "command",
    });
    expect(() =>
      decryptE2EEV2Frame({
        key: keys.clientToDaemonKey,
        noncePrefix: keys.noncePrefix,
        expectedCounter: 2n,
        data: frame,
      }),
    ).toThrow("replayed frame");
    expect(() =>
      decryptE2EEV2Frame({
        key: keys.daemonToClientKey,
        noncePrefix: keys.noncePrefix,
        expectedCounter: 1n,
        data: frame,
      }),
    ).toThrow("authentication failed");

    const tampered = new Uint8Array(frame);
    tampered[3] = 1;
    expect(() =>
      decryptE2EEV2Frame({
        key: keys.clientToDaemonKey,
        noncePrefix: keys.noncePrefix,
        expectedCounter: 1n,
        data: tampered.buffer,
      }),
    ).toThrow("kind mismatch");
  });
});
