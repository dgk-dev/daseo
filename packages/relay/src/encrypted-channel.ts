/// <reference lib="dom" />
/**
 * Encrypted channel that wraps a WebSocket-like transport.
 *
 * Handles ECDH handshake and encrypts/decrypts all messages.
 * Works identically for daemon and client sides.
 */

import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
  type KeyPair,
  exportSigningPublicKey,
  importSigningPublicKey,
  signDetached,
  verifyDetached,
  type SharedKey,
  type SigningKeyPair,
} from "./crypto.js";
import {
  decryptE2EEV2Frame,
  deriveE2EEV2SessionKeys,
  encryptE2EEV2Frame,
  E2EE_V2_WIRE_OVERHEAD_BYTES,
} from "./e2ee-v2.js";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64.js";

export interface Transport {
  send(data: string | ArrayBuffer): void | Promise<void>;
  close(code?: number, reason?: string): void;
  onmessage: ((message: TransportMessage) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((error: Error) => void) | null;
}

export interface TransportMessage {
  data: string | ArrayBuffer;
  isBinary: boolean;
}

export interface EncryptedChannelEvents {
  onopen?: () => void;
  onmessage?: (data: string | ArrayBuffer) => void;
  onclose?: (code: number, reason: string) => void;
  onerror?: (error: Error) => void;
}

type ChannelState = "connecting" | "handshaking" | "open" | "closed";

export interface E2EEV2PeerIdentity {
  deviceId: string;
  scopes: readonly string[];
}

export interface E2EEV2ClientConfig {
  daemonSigningPublicKeyB64: string;
  keyEpoch: number;
  offerId?: string;
  pairingSecret?: string;
  deviceId: string;
  deviceSigningKeyPair: SigningKeyPair;
  label?: string;
  platform?: string;
  appVersion?: string;
}

export interface E2EEV2DaemonConfig {
  signingKeyPair: SigningKeyPair;
  keyEpoch: number;
  authorizeDevice(input: {
    offerId?: string;
    pairingSecret?: string;
    deviceId: string;
    signingPublicKeyB64: string;
    label?: string;
    platform?: string;
    appVersion?: string;
  }): Promise<E2EEV2PeerIdentity>;
}

interface EncryptedChannelOptions {
  /**
   * If set, the channel can validate repeated plaintext `{type:"e2ee_hello"}`
   * messages even after it is open.
   *
   * This is useful for robustness when the client retries the handshake
   * (e.g., it didn't observe the daemon's `{type:"e2ee_ready"}` yet). In that case,
   * the daemon should re-send `{type:"e2ee_ready"}` without changing keys.
   */
  daemonKeyPair?: KeyPair;
  binaryCiphertext?: boolean;
  v2?: {
    sendKey: Uint8Array;
    receiveKey: Uint8Array;
    noncePrefix: Uint8Array;
    sendCounter: bigint;
    receiveCounter: bigint;
    sessionId: string;
  };
  peerIdentity?: E2EEV2PeerIdentity;
}

interface E2EEHelloMessage {
  type: "e2ee_hello";
  key: string;
  capabilities?: E2EECapabilities;
}

interface E2EEReadyMessage {
  type: "e2ee_ready";
  capabilities?: E2EECapabilities;
}

interface E2EECapabilities {
  binaryCiphertext?: boolean;
}

interface E2EEV2HelloMessage {
  type: "e2ee_hello_v2";
  offerId?: string;
  encryptedPairingSecretB64?: string;
  deviceId: string;
  deviceSigningPublicKeyB64: string;
  clientEphemeralKeyB64: string;
  clientNonceB64: string;
  keyEpoch: number;
  label?: string;
  platform?: string;
  appVersion?: string;
  signatureB64: string;
}

interface E2EEV2ReadyMessage {
  type: "e2ee_ready_v2";
  daemonEphemeralKeyB64: string;
  daemonNonceB64: string;
  keyEpoch: number;
  sessionId: string;
  signatureB64: string;
  capabilities: { binaryCiphertext: true; counters: true };
}

function bytesToBase64(bytes: Uint8Array): string {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return arrayBufferToBase64(copy.buffer);
}

function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(value));
}

function canonicalJson(value: Record<string, unknown>): string {
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
}

function v2HelloCore(message: Omit<E2EEV2HelloMessage, "signatureB64">): string {
  return canonicalJson(message);
}

function v2Transcript(
  hello: Omit<E2EEV2HelloMessage, "signatureB64">,
  ready: Omit<E2EEV2ReadyMessage, "signatureB64" | "sessionId">,
): string {
  return canonicalJson({ hello: v2HelloCore(hello), ready: canonicalJson(ready) });
}

function isE2EEV2HelloMessage(value: unknown): value is E2EEV2HelloMessage {
  return (
    isRecord(value) &&
    value.type === "e2ee_hello_v2" &&
    typeof value.deviceId === "string" &&
    typeof value.deviceSigningPublicKeyB64 === "string" &&
    typeof value.clientEphemeralKeyB64 === "string" &&
    typeof value.clientNonceB64 === "string" &&
    typeof value.keyEpoch === "number" &&
    typeof value.signatureB64 === "string"
  );
}

function isE2EEV2ReadyMessage(value: unknown): value is E2EEV2ReadyMessage {
  return (
    isRecord(value) &&
    value.type === "e2ee_ready_v2" &&
    typeof value.daemonEphemeralKeyB64 === "string" &&
    typeof value.daemonNonceB64 === "string" &&
    typeof value.keyEpoch === "number" &&
    typeof value.sessionId === "string" &&
    typeof value.signatureB64 === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isE2EECapabilities(value: unknown): value is E2EECapabilities {
  return (
    value === undefined ||
    (isRecord(value) &&
      (value.binaryCiphertext === undefined || typeof value.binaryCiphertext === "boolean"))
  );
}

function isE2EEHelloMessage(value: unknown): value is E2EEHelloMessage {
  return (
    isRecord(value) &&
    value.type === "e2ee_hello" &&
    typeof value.key === "string" &&
    value.key.trim().length > 0 &&
    isE2EECapabilities(value.capabilities)
  );
}

function isE2EEReadyMessage(value: unknown): value is E2EEReadyMessage {
  return isRecord(value) && value.type === "e2ee_ready" && isE2EECapabilities(value.capabilities);
}

function supportsBinaryCiphertext(message: E2EEHelloMessage | E2EEReadyMessage): boolean {
  return message.capabilities?.binaryCiphertext === true;
}

function buildInvalidHelloError(rawText: string, parsed?: unknown): Error {
  const parsedRecord = isRecord(parsed) ? parsed : null;
  const rawType = parsedRecord?.type;
  function describeType(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    return typeof value;
  }
  const receivedType = describeType(rawType);
  const hasKey = typeof parsedRecord?.key === "string" && parsedRecord.key.trim().length > 0;
  const compact = rawText.replace(/\s+/g, " ").trim();
  const preview = compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
  return new Error(
    `Invalid hello message (receivedType=${receivedType}, hasKey=${hasKey}, preview=${JSON.stringify(preview)})`,
  );
}

const HANDSHAKE_RETRY_MS = 1000;
const MAX_PENDING_SENDS = 200;
const REHANDSHAKE_KEY_MISMATCH_CLOSE_CODE = 1008;
const ENCRYPTED_PAYLOAD_OVERHEAD_BYTES = 40;

export function base64EncryptedWireByteLength(plaintextBytes: number): number {
  return 4 * Math.ceil((plaintextBytes + ENCRYPTED_PAYLOAD_OVERHEAD_BYTES) / 3);
}

export function maxBase64EncryptedPlaintextByteLength(wireBytes: number): number {
  return Math.floor(wireBytes / 4) * 3 - ENCRYPTED_PAYLOAD_OVERHEAD_BYTES;
}
const REHANDSHAKE_KEY_MISMATCH_CLOSE_REASON = "E2EE re-handshake key mismatch";

interface TimeoutWithUnref {
  unref(): void;
}

function hasUnref(timeout: unknown): timeout is TimeoutWithUnref {
  return (
    typeof timeout === "object" &&
    timeout !== null &&
    "unref" in timeout &&
    typeof (timeout as Record<string, unknown>).unref === "function"
  );
}

/**
 * Creates an encrypted channel as the initiator (client).
 *
 * The client:
 * 1. Receives daemon's public key via QR code
 * 2. Generates own keypair
 * 3. Sends e2ee_hello with own public key
 * 4. Derives shared key and starts encrypted communication
 */
export async function createClientChannel(
  transport: Transport,
  daemonPublicKeyB64: string,
  events: EncryptedChannelEvents = {},
): Promise<EncryptedChannel> {
  const keyPair = generateKeyPair();
  const daemonPublicKey = importPublicKey(daemonPublicKeyB64);
  const sharedKey = deriveSharedKey(keyPair.secretKey, daemonPublicKey);

  const channel = new EncryptedChannel(transport, sharedKey, events);

  // Send e2ee_hello with our public key
  const ourPublicKeyB64 = exportPublicKey(keyPair.publicKey);
  const hello: E2EEHelloMessage = {
    type: "e2ee_hello",
    key: ourPublicKeyB64,
    capabilities: { binaryCiphertext: true },
  };
  const helloText = JSON.stringify(hello);

  let retry: ReturnType<typeof setInterval> | null = null;
  const emitSendError = (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    events.onerror?.(err);
  };
  const sendHello = () => {
    try {
      const result = transport.send(helloText);
      if (result) {
        void result.catch(emitSendError);
      }
      return true;
    } catch (error) {
      // This can happen during daemon restarts while the socket transitions
      // through CLOSING/CLOSED states. Report it but do not throw from timers.
      emitSendError(error);
      return false;
    }
  };
  const clearRetry = () => {
    if (retry) {
      clearInterval(retry);
      retry = null;
    }
  };

  channel.onTransitionToOpen(() => clearRetry());
  channel.onClose(() => clearRetry());

  sendHello();
  retry = setInterval(() => {
    if (channel.isOpen()) {
      clearRetry();
      return;
    }
    sendHello();
  }, HANDSHAKE_RETRY_MS);
  // Avoid keeping Node processes alive (e.g. tests) if the handshake is stuck.
  if (hasUnref(retry)) {
    retry.unref();
  }

  return channel;
}

export async function createClientChannelV2(
  transport: Transport,
  daemonPublicKeyB64: string,
  config: E2EEV2ClientConfig,
  events: EncryptedChannelEvents = {},
): Promise<EncryptedChannel> {
  const ephemeral = generateKeyPair();
  const daemonLegacyPublicKey = importPublicKey(daemonPublicKeyB64);
  const legacySharedKey = deriveSharedKey(ephemeral.secretKey, daemonLegacyPublicKey);
  const encryptedPairingSecretB64 = config.pairingSecret
    ? arrayBufferToBase64(encrypt(legacySharedKey, config.pairingSecret))
    : undefined;
  const helloCore: Omit<E2EEV2HelloMessage, "signatureB64"> = {
    type: "e2ee_hello_v2",
    ...(config.offerId ? { offerId: config.offerId } : {}),
    ...(encryptedPairingSecretB64 ? { encryptedPairingSecretB64 } : {}),
    deviceId: config.deviceId,
    deviceSigningPublicKeyB64: exportSigningPublicKey(config.deviceSigningKeyPair.publicKey),
    clientEphemeralKeyB64: exportPublicKey(ephemeral.publicKey),
    clientNonceB64: bytesToBase64(generateKeyPair().publicKey),
    keyEpoch: config.keyEpoch,
    ...(config.label ? { label: config.label } : {}),
    ...(config.platform ? { platform: config.platform } : {}),
    ...(config.appVersion ? { appVersion: config.appVersion } : {}),
  };
  const hello: E2EEV2HelloMessage = {
    ...helloCore,
    signatureB64: bytesToBase64(
      signDetached(
        new TextEncoder().encode(v2HelloCore(helloCore)),
        config.deviceSigningKeyPair.secretKey,
      ),
    ),
  };
  const helloText = JSON.stringify(hello);

  return await new Promise<EncryptedChannel>((resolve, reject) => {
    const buffered: TransportMessage[] = [];
    let settled = false;
    let processingReady = false;
    let retry: ReturnType<typeof setInterval> | null = null;
    const clearRetry = () => {
      if (!retry) return;
      clearInterval(retry);
      retry = null;
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearRetry();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const sendHello = () => {
      try {
        const result = transport.send(helloText);
        if (result) void result.catch(fail);
      } catch (error) {
        fail(error);
      }
    };

    Object.assign(transport, {
      onmessage: async (message: TransportMessage) => {
        if (processingReady) {
          buffered.push(message);
          return;
        }
        try {
          if (message.isBinary) throw new Error("E2EE v2 ready must be text");
          const parsed: unknown = JSON.parse(decodeTransportText(message.data));
          if (!isE2EEV2ReadyMessage(parsed)) return;
          processingReady = true;
          if (parsed.keyEpoch !== config.keyEpoch) throw new Error("Daemon key epoch changed");
          const readyCore: Omit<E2EEV2ReadyMessage, "signatureB64" | "sessionId"> = {
            type: "e2ee_ready_v2",
            daemonEphemeralKeyB64: parsed.daemonEphemeralKeyB64,
            daemonNonceB64: parsed.daemonNonceB64,
            keyEpoch: parsed.keyEpoch,
            capabilities: { binaryCiphertext: true, counters: true },
          };
          const transcript = v2Transcript(helloCore, readyCore);
          if (
            !verifyDetached(
              new TextEncoder().encode(transcript),
              base64ToBytes(parsed.signatureB64),
              importSigningPublicKey(config.daemonSigningPublicKeyB64),
            )
          ) {
            throw new Error("Daemon E2EE v2 transcript signature is invalid");
          }
          const sharedKey = deriveSharedKey(
            ephemeral.secretKey,
            importPublicKey(parsed.daemonEphemeralKeyB64),
          );
          const keys = deriveE2EEV2SessionKeys(sharedKey, transcript);
          if (keys.sessionId !== parsed.sessionId) throw new Error("E2EE v2 session id mismatch");
          const channel = new EncryptedChannel(transport, keys.clientToDaemonKey, events, {
            binaryCiphertext: true,
            v2: {
              sendKey: keys.clientToDaemonKey,
              receiveKey: keys.daemonToClientKey,
              noncePrefix: keys.noncePrefix,
              sendCounter: 0n,
              receiveCounter: 0n,
              sessionId: keys.sessionId,
            },
          });
          channel.setState("open");
          settled = true;
          clearRetry();
          events.onopen?.();
          for (const pending of buffered) transport.onmessage?.(pending);
          resolve(channel);
        } catch (error) {
          fail(error);
        }
      },
      onerror: fail,
      onclose: (code: number, reason: string) =>
        fail(new Error(`Connection closed during E2EE v2 handshake: ${code} ${reason}`)),
    });

    sendHello();
    retry = setInterval(sendHello, HANDSHAKE_RETRY_MS);
    if (hasUnref(retry)) retry.unref();
  });
}

async function acceptDaemonV2Hello(input: {
  transport: Transport;
  daemonKeyPair: KeyPair;
  events: EncryptedChannelEvents;
  config: E2EEV2DaemonConfig;
  hello: E2EEV2HelloMessage;
}): Promise<EncryptedChannel> {
  const { hello, config } = input;
  if (hello.keyEpoch !== config.keyEpoch) throw new Error("Daemon key epoch changed");
  const helloCore: Omit<E2EEV2HelloMessage, "signatureB64"> = {
    type: "e2ee_hello_v2",
    ...(hello.offerId ? { offerId: hello.offerId } : {}),
    ...(hello.encryptedPairingSecretB64
      ? { encryptedPairingSecretB64: hello.encryptedPairingSecretB64 }
      : {}),
    deviceId: hello.deviceId,
    deviceSigningPublicKeyB64: hello.deviceSigningPublicKeyB64,
    clientEphemeralKeyB64: hello.clientEphemeralKeyB64,
    clientNonceB64: hello.clientNonceB64,
    keyEpoch: hello.keyEpoch,
    ...(hello.label ? { label: hello.label } : {}),
    ...(hello.platform ? { platform: hello.platform } : {}),
    ...(hello.appVersion ? { appVersion: hello.appVersion } : {}),
  };
  if (
    !verifyDetached(
      new TextEncoder().encode(v2HelloCore(helloCore)),
      base64ToBytes(hello.signatureB64),
      importSigningPublicKey(hello.deviceSigningPublicKeyB64),
    )
  ) {
    throw new Error("Device E2EE v2 hello signature is invalid");
  }
  const clientEphemeralPublicKey = importPublicKey(hello.clientEphemeralKeyB64);
  const legacySharedKey = deriveSharedKey(input.daemonKeyPair.secretKey, clientEphemeralPublicKey);
  const pairingSecret = hello.encryptedPairingSecretB64
    ? new TextDecoder("utf-8", { fatal: true }).decode(
        decrypt(legacySharedKey, base64ToArrayBuffer(hello.encryptedPairingSecretB64)),
      )
    : undefined;
  const peerIdentity = await config.authorizeDevice({
    offerId: hello.offerId,
    pairingSecret,
    deviceId: hello.deviceId,
    signingPublicKeyB64: hello.deviceSigningPublicKeyB64,
    label: hello.label,
    platform: hello.platform,
    appVersion: hello.appVersion,
  });
  const daemonEphemeral = generateKeyPair();
  const readyCore: Omit<E2EEV2ReadyMessage, "signatureB64" | "sessionId"> = {
    type: "e2ee_ready_v2",
    daemonEphemeralKeyB64: exportPublicKey(daemonEphemeral.publicKey),
    daemonNonceB64: bytesToBase64(generateKeyPair().publicKey),
    keyEpoch: config.keyEpoch,
    capabilities: { binaryCiphertext: true, counters: true },
  };
  const transcript = v2Transcript(helloCore, readyCore);
  const sharedKey = deriveSharedKey(daemonEphemeral.secretKey, clientEphemeralPublicKey);
  const keys = deriveE2EEV2SessionKeys(sharedKey, transcript);
  await input.transport.send(
    JSON.stringify({
      ...readyCore,
      sessionId: keys.sessionId,
      signatureB64: bytesToBase64(
        signDetached(new TextEncoder().encode(transcript), config.signingKeyPair.secretKey),
      ),
    } satisfies E2EEV2ReadyMessage),
  );
  return new EncryptedChannel(input.transport, keys.daemonToClientKey, input.events, {
    binaryCiphertext: true,
    peerIdentity,
    v2: {
      sendKey: keys.daemonToClientKey,
      receiveKey: keys.clientToDaemonKey,
      noncePrefix: keys.noncePrefix,
      sendCounter: 0n,
      receiveCounter: 0n,
      sessionId: keys.sessionId,
    },
  });
}

/**
 * Creates an encrypted channel as the responder (daemon).
 *
 * The daemon:
 * 1. Has pre-generated keypair (public key was in QR)
 * 2. Waits for client's e2ee_hello with their public key
 * 3. Derives shared key and starts encrypted communication
 */
export async function createDaemonChannel(
  transport: Transport,
  daemonKeyPair: KeyPair,
  events: EncryptedChannelEvents = {},
  v2Config?: E2EEV2DaemonConfig,
): Promise<EncryptedChannel> {
  return new Promise((resolve, reject) => {
    const bufferedMessages: TransportMessage[] = [];
    const shouldIgnorePostHelloPlaintext = (message: TransportMessage): boolean => {
      try {
        if (message.isBinary) return false;
        const text = decodeTransportText(message.data);
        const parsed: unknown = JSON.parse(text);
        return (
          isE2EEHelloMessage(parsed) ||
          isE2EEReadyMessage(parsed) ||
          isE2EEV2HelloMessage(parsed) ||
          isE2EEV2ReadyMessage(parsed)
        );
      } catch {
        return false;
      }
    };

    const handleHello = async (message: TransportMessage): Promise<void> => {
      try {
        if (message.isBinary) {
          throw buildInvalidHelloError("<binary frame>");
        }
        const helloText = decodeTransportText(message.data);

        let parsed: unknown;
        try {
          parsed = JSON.parse(helloText);
        } catch {
          throw buildInvalidHelloError(helloText);
        }

        // Buffer frames while authentication and key derivation are in flight.
        Object.assign(transport, {
          onmessage: (next: TransportMessage) => bufferedMessages.push(next),
        });

        if (isE2EEV2HelloMessage(parsed)) {
          if (!v2Config) throw new Error("Daemon does not support E2EE v2");
          const channel = await acceptDaemonV2Hello({
            transport,
            daemonKeyPair,
            events,
            config: v2Config,
            hello: parsed,
          });
          channel.setState("open");
          events.onopen?.();
          for (const buffered of bufferedMessages) {
            if (shouldIgnorePostHelloPlaintext(buffered)) continue;
            transport.onmessage?.(buffered);
          }
          resolve(channel);
          return;
        }

        if (!isE2EEHelloMessage(parsed)) {
          throw buildInvalidHelloError(helloText, parsed);
        }

        const msg = parsed;

        const clientPublicKey = importPublicKey(msg.key);
        const sharedKey = deriveSharedKey(daemonKeyPair.secretKey, clientPublicKey);

        const binaryCiphertext = supportsBinaryCiphertext(msg);
        await transport.send(
          JSON.stringify({
            type: "e2ee_ready",
            ...(binaryCiphertext
              ? { capabilities: { binaryCiphertext: true } satisfies E2EECapabilities }
              : {}),
          } satisfies E2EEReadyMessage),
        );

        const channel = new EncryptedChannel(transport, sharedKey, events, {
          daemonKeyPair,
          binaryCiphertext,
        });
        channel.setState("open");
        events.onopen?.();

        for (const buffered of bufferedMessages) {
          if (shouldIgnorePostHelloPlaintext(buffered)) continue;
          transport.onmessage?.(buffered);
        }

        resolve(channel);
      } catch (error) {
        reject(error);
      }
    };

    Object.assign(transport, {
      onmessage: handleHello,
      onerror: (error: Error) => {
        reject(error);
      },
      onclose: (code: number, reason: string) => {
        reject(new Error(`Connection closed during handshake: ${code} ${reason}`));
      },
    });
  });
}

/**
 * Encrypted channel that wraps a transport with E2EE.
 */
export class EncryptedChannel {
  private transport: Transport;
  private sharedKey: SharedKey;
  private state: ChannelState = "handshaking";
  private events: EncryptedChannelEvents;
  private options: EncryptedChannelOptions;
  private pendingSends: Array<string | ArrayBuffer> = [];
  private onOpenCallbacks: Array<() => void> = [];
  private onCloseCallbacks: Array<() => void> = [];
  private v2SendTail: Promise<void> = Promise.resolve();
  private v2ReceiveTail: Promise<void> = Promise.resolve();

  constructor(
    transport: Transport,
    sharedKey: SharedKey,
    events: EncryptedChannelEvents = {},
    options: EncryptedChannelOptions = {},
  ) {
    this.transport = transport;
    this.sharedKey = sharedKey;
    this.events = events;
    this.options = options;

    Object.assign(transport, {
      onmessage: (message: TransportMessage) => this.handleMessage(message),
      onclose: (code: number, reason: string) => {
        this.state = "closed";
        this.events.onclose?.(code, reason);
        for (const cb of this.onCloseCallbacks) cb();
      },
      onerror: (error: Error) => {
        this.events.onerror?.(error);
      },
    });
  }

  setState(state: ChannelState): void {
    this.state = state;
  }

  private async handleMessage(message: TransportMessage): Promise<void> {
    if (this.state === "handshaking") {
      try {
        if (message.isBinary) return;
        const text = decodeTransportText(message.data);
        const parsed: unknown = JSON.parse(text);
        if (isE2EEReadyMessage(parsed)) {
          this.options.binaryCiphertext = supportsBinaryCiphertext(parsed);
          this.state = "open";
          this.events.onopen?.();
          for (const cb of this.onOpenCallbacks) cb();
          try {
            await this.flushPendingSends();
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.events.onerror?.(err);
            this.state = "closed";
            this.transport.close(1011, err.message);
          }
        }
      } catch {
        // ignore non-ready handshake traffic
      }
      return;
    }

    if (this.state !== "open") return;

    if (this.options.v2) {
      const previous = this.v2ReceiveTail;
      const operation = (async () => {
        await previous;
        try {
          if (!message.isBinary) {
            const text = decodeTransportText(message.data);
            if (text.trim().startsWith("{")) {
              const parsed: unknown = JSON.parse(text);
              if (isE2EEV2HelloMessage(parsed) || isE2EEV2ReadyMessage(parsed)) return;
              throw new Error("Received plaintext frame on E2EE v2 channel");
            }
          }
          const ciphertext = message.isBinary
            ? requireArrayBuffer(message.data)
            : base64ToArrayBuffer(decodeTransportText(message.data));
          const v2 = this.options.v2;
          if (!v2) throw new Error("E2EE v2 state was cleared");
          const expectedCounter = v2.receiveCounter + 1n;
          const opened = decryptE2EEV2Frame({
            key: v2.receiveKey,
            noncePrefix: v2.noncePrefix,
            expectedCounter,
            data: ciphertext,
          });
          v2.receiveCounter = opened.counter;
          this.events.onmessage?.(opened.data);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.state = "closed";
          this.events.onerror?.(err);
          this.transport.close(1008, err.message);
        }
      })();
      this.v2ReceiveTail = operation.catch(() => undefined);
      await operation;
      return;
    }

    try {
      const ciphertext = await (async () => {
        // Handle (or ignore) any stray plaintext handshake traffic.
        try {
          if (message.isBinary) throw new Error("not plaintext handshake traffic");
          const text = decodeTransportText(message.data);
          if (text.trim().startsWith("{")) {
            const parsed: unknown = JSON.parse(text);

            if (isE2EEHelloMessage(parsed)) {
              if (this.options.daemonKeyPair) {
                await this.handleDaemonRehello(parsed);
              }
              return null;
            }

            if (isE2EEReadyMessage(parsed)) {
              return null;
            }

            // Any other JSON-looking payload is plaintext app traffic, which
            // means the peer is not encrypting (or we are out of sync).
            throw new Error("Received plaintext frame on encrypted channel");
          }
        } catch (error) {
          // If we detected plaintext protocol mismatch, fail hard.
          if (error instanceof Error && error.message.includes("plaintext frame")) {
            throw error;
          }
          // Otherwise ignore JSON parse/TextDecoder failures and fall back to
          // decoding ciphertext below.
        }

        if (this.options.binaryCiphertext) {
          return message.isBinary
            ? { data: requireArrayBuffer(message.data), isBinary: true as const }
            : {
                data: base64ToArrayBuffer(decodeTransportText(message.data)),
                isBinary: false as const,
              };
        }

        // COMPAT(binaryCiphertext): added in v0.2.3, remove legacy base64-only
        // receive mode after 2027-01-27.
        if (!message.isBinary) {
          return { data: base64ToArrayBuffer(decodeTransportText(message.data)), isBinary: null };
        }

        // Older transport adapters could lose the opcode. Retain the former
        // base64-first behavior only in the legacy path.
        try {
          return { data: base64ToArrayBuffer(decodeTransportText(message.data)), isBinary: null };
        } catch {
          return { data: requireArrayBuffer(message.data), isBinary: null };
        }
      })();

      if (ciphertext) {
        const plaintextBytes = decrypt(this.sharedKey, ciphertext.data);
        const plaintext = decodePlaintext(plaintextBytes, ciphertext.isBinary);
        this.events.onmessage?.(plaintext);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // Treat decryption/protocol errors as fatal so the peer can reconnect and
      // re-handshake. Emitting an error event here can cause higher-level code
      // to tear down the session without triggering a clean reconnect.
      try {
        this.transport.close(1011, err.message);
      } catch {
        // ignore
      }
    }
  }

  async send(data: string | ArrayBuffer): Promise<void> {
    if (this.state === "handshaking") {
      if (this.pendingSends.length >= MAX_PENDING_SENDS) {
        this.pendingSends.shift();
      }
      this.pendingSends.push(data);
      return;
    }

    if (this.state !== "open") {
      throw new Error("Channel not open");
    }

    if (this.options.v2) {
      const previous = this.v2SendTail;
      const operation = (async () => {
        await previous;
        if (this.state !== "open") throw new Error("Channel not open");
        const v2 = this.options.v2;
        if (!v2) throw new Error("E2EE v2 state was cleared");
        const counter = v2.sendCounter + 1n;
        // Consume the counter before encryption or transport I/O. Reusing it
        // after an ambiguous send would reuse the session key/nonce pair.
        v2.sendCounter = counter;
        try {
          const ciphertext = encryptE2EEV2Frame({
            key: v2.sendKey,
            noncePrefix: v2.noncePrefix,
            counter,
            data,
          });
          await this.transport.send(
            data instanceof ArrayBuffer ? ciphertext : arrayBufferToBase64(ciphertext),
          );
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.state = "closed";
          this.events.onerror?.(err);
          try {
            this.transport.close(1011, "E2EE v2 send failed");
          } catch {
            // The channel is already permanently closed even if the adapter
            // cannot emit another close frame.
          }
          throw err;
        }
      })();
      this.v2SendTail = operation.catch(() => undefined);
      await operation;
      return;
    }

    const ciphertext = encrypt(this.sharedKey, data);
    if (this.options.binaryCiphertext && data instanceof ArrayBuffer) {
      await this.transport.send(ciphertext);
      return;
    }
    // COMPAT(binaryCiphertext): added in v0.2.3, remove base64 binary sends
    // after 2027-01-27 once the supported peer floor includes negotiation.
    await this.transport.send(arrayBufferToBase64(ciphertext));
  }

  outboundWireByteLength(data: string | ArrayBuffer): number {
    const plaintextBytes = utf8ByteLength(data);
    if (this.options.v2) {
      const encryptedBytes = plaintextBytes + E2EE_V2_WIRE_OVERHEAD_BYTES;
      return data instanceof ArrayBuffer ? encryptedBytes : 4 * Math.ceil(encryptedBytes / 3);
    }
    const encryptedBytes = plaintextBytes + ENCRYPTED_PAYLOAD_OVERHEAD_BYTES;
    if (this.options.binaryCiphertext && data instanceof ArrayBuffer) {
      return encryptedBytes;
    }
    return base64EncryptedWireByteLength(plaintextBytes);
  }

  private async flushPendingSends(): Promise<void> {
    if (this.state !== "open") return;
    const pending = this.pendingSends;
    this.pendingSends = [];
    for (const item of pending) {
      await this.send(item);
    }
  }

  private async handleDaemonRehello(message: E2EEHelloMessage): Promise<void> {
    if (!this.options.daemonKeyPair) return;
    const clientPublicKey = importPublicKey(message.key);
    const nextSharedKey = deriveSharedKey(this.options.daemonKeyPair.secretKey, clientPublicKey);

    // If it's the same client key (handshake retry), re-send
    // "ready" but do not re-key. Re-keying here would desync
    // the channel and cause decrypt failures.
    if (keysEqual(nextSharedKey, this.sharedKey)) {
      await this.transport.send(
        JSON.stringify({
          type: "e2ee_ready",
          ...(this.options.binaryCiphertext
            ? { capabilities: { binaryCiphertext: true } satisfies E2EECapabilities }
            : {}),
        } satisfies E2EEReadyMessage),
      );
      return;
    }

    // A different key on an already-open encrypted channel is not an
    // authenticated reconnect. Close and require a fresh transport instead of
    // allowing the relay to switch this channel to an attacker-chosen key.
    this.state = "closed";
    this.transport.close(
      REHANDSHAKE_KEY_MISMATCH_CLOSE_CODE,
      REHANDSHAKE_KEY_MISMATCH_CLOSE_REASON,
    );
  }

  close(code = 1000, reason = "Normal closure"): void {
    this.state = "closed";
    this.transport.close(code, reason);
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  getPeerIdentity(): E2EEV2PeerIdentity | null {
    return this.options.peerIdentity ?? null;
  }

  onTransitionToOpen(cb: () => void): void {
    this.onOpenCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    this.onCloseCallbacks.push(cb);
  }
}

function decodeTransportText(data: string | ArrayBuffer): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

function requireArrayBuffer(data: string | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  throw new Error("Binary WebSocket frame did not contain bytes");
}

function decodeLegacyPlaintext(data: ArrayBuffer): string | ArrayBuffer {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return data;
  }
}

function decodePlaintext(data: ArrayBuffer, isBinary: boolean | null): string | ArrayBuffer {
  if (isBinary === true) return data;
  if (isBinary === false) return new TextDecoder("utf-8", { fatal: true }).decode(data);
  return decodeLegacyPlaintext(data);
}

function utf8ByteLength(data: string | ArrayBuffer): number {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}
