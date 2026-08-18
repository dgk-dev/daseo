import { hashBytes, secretboxDecrypt, secretboxEncrypt } from "./crypto.js";

const FRAME_MAGIC_0 = 0x50;
const FRAME_MAGIC_1 = 0x32;
const FRAME_VERSION = 2;
const HEADER_BYTES = 12;
const NONCE_PREFIX_BYTES = 16;
const KEY_BYTES = 32;

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function hmacSha512(keyInput: Uint8Array, data: Uint8Array): Uint8Array {
  const blockSize = 128;
  const key = keyInput.byteLength > blockSize ? hashBytes(keyInput) : keyInput;
  const padded = new Uint8Array(blockSize);
  padded.set(key);
  const innerPad = new Uint8Array(blockSize);
  const outerPad = new Uint8Array(blockSize);
  for (let index = 0; index < blockSize; index += 1) {
    innerPad[index] = padded[index] ^ 0x36;
    outerPad[index] = padded[index] ^ 0x5c;
  }
  return hashBytes(concat(outerPad, hashBytes(concat(innerPad, data))));
}

function hkdfExpand(prk: Uint8Array, info: string, length: number): Uint8Array {
  const encoder = new TextEncoder();
  const infoBytes = encoder.encode(info);
  const chunks: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array(0);
  let counter = 1;
  while (chunks.reduce((total, chunk) => total + chunk.byteLength, 0) < length) {
    previous = hmacSha512(prk, concat(previous, infoBytes, Uint8Array.of(counter)));
    chunks.push(previous);
    counter += 1;
  }
  return concat(...chunks).slice(0, length);
}

export interface E2EEV2SessionKeys {
  clientToDaemonKey: Uint8Array;
  daemonToClientKey: Uint8Array;
  noncePrefix: Uint8Array;
  sessionId: string;
}

export function deriveE2EEV2SessionKeys(
  sharedKey: Uint8Array,
  transcript: string,
): E2EEV2SessionKeys {
  const transcriptHash = hashBytes(new TextEncoder().encode(transcript));
  const prk = hmacSha512(transcriptHash, sharedKey);
  const sessionBytes = hkdfExpand(prk, "paseo/e2ee-v2/session", 32);
  return {
    clientToDaemonKey: hkdfExpand(prk, "paseo/e2ee-v2/client-to-daemon", KEY_BYTES),
    daemonToClientKey: hkdfExpand(prk, "paseo/e2ee-v2/daemon-to-client", KEY_BYTES),
    noncePrefix: hkdfExpand(prk, "paseo/e2ee-v2/nonce-prefix", NONCE_PREFIX_BYTES),
    sessionId: Array.from(sessionBytes.slice(0, 12), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

function writeCounter(view: DataView, counter: bigint, offset: number): void {
  view.setUint32(offset, Number((counter >> 32n) & 0xffff_ffffn), false);
  view.setUint32(offset + 4, Number(counter & 0xffff_ffffn), false);
}

function readCounter(view: DataView, offset: number): bigint {
  return (BigInt(view.getUint32(offset, false)) << 32n) | BigInt(view.getUint32(offset + 4, false));
}

function buildNonce(prefix: Uint8Array, counter: bigint): Uint8Array {
  if (prefix.byteLength !== NONCE_PREFIX_BYTES) throw new Error("Invalid E2EE v2 nonce prefix");
  const nonce = new Uint8Array(24);
  nonce.set(prefix, 0);
  writeCounter(new DataView(nonce.buffer), counter, NONCE_PREFIX_BYTES);
  return nonce;
}

function toBytes(data: string | ArrayBuffer): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes);
  return output.buffer;
}

export function encryptE2EEV2Frame(input: {
  key: Uint8Array;
  noncePrefix: Uint8Array;
  counter: bigint;
  data: string | ArrayBuffer;
}): ArrayBuffer {
  if (input.counter <= 0n) throw new Error("E2EE v2 counters start at one");
  const binary = input.data instanceof ArrayBuffer;
  const plaintext = concat(Uint8Array.of(binary ? 1 : 0), toBytes(input.data));
  const ciphertext = secretboxEncrypt(
    plaintext,
    buildNonce(input.noncePrefix, input.counter),
    input.key,
  );
  const output = new Uint8Array(HEADER_BYTES + ciphertext.byteLength);
  output[0] = FRAME_MAGIC_0;
  output[1] = FRAME_MAGIC_1;
  output[2] = FRAME_VERSION;
  output[3] = binary ? 1 : 0;
  writeCounter(new DataView(output.buffer), input.counter, 4);
  output.set(ciphertext, HEADER_BYTES);
  return output.buffer;
}

export function decryptE2EEV2Frame(input: {
  key: Uint8Array;
  noncePrefix: Uint8Array;
  expectedCounter: bigint;
  data: ArrayBuffer;
}): { data: string | ArrayBuffer; counter: bigint } {
  const bytes = new Uint8Array(input.data);
  if (bytes.byteLength <= HEADER_BYTES) throw new Error("E2EE v2 frame is too short");
  if (bytes[0] !== FRAME_MAGIC_0 || bytes[1] !== FRAME_MAGIC_1 || bytes[2] !== FRAME_VERSION) {
    throw new Error("Invalid E2EE v2 frame header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const counter = readCounter(view, 4);
  if (counter !== input.expectedCounter) {
    throw new Error(
      counter < input.expectedCounter
        ? "E2EE v2 replayed frame rejected"
        : "E2EE v2 frame counter gap rejected",
    );
  }
  const plaintext = secretboxDecrypt(
    bytes.slice(HEADER_BYTES),
    buildNonce(input.noncePrefix, counter),
    input.key,
  );
  const binary = bytes[3] === 1;
  if (plaintext[0] !== (binary ? 1 : 0)) throw new Error("E2EE v2 frame kind mismatch");
  const payload = plaintext.slice(1);
  return {
    counter,
    data: binary
      ? toArrayBuffer(payload)
      : new TextDecoder("utf-8", { fatal: true }).decode(payload),
  };
}

export const E2EE_V2_WIRE_OVERHEAD_BYTES = HEADER_BYTES + 16 + 1;
