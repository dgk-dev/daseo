export {
  createClientChannel,
  createClientChannelV2,
  createDaemonChannel,
  EncryptedChannel,
} from "./encrypted-channel.js";
export type {
  Transport,
  TransportMessage,
  EncryptedChannelEvents,
  E2EEV2ClientConfig,
  E2EEV2DaemonConfig,
  E2EEV2PeerIdentity,
} from "./encrypted-channel.js";

export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportSecretKey,
  importSecretKey,
  generateSigningKeyPair,
  exportSigningPublicKey,
  exportSigningSecretKey,
  importSigningPublicKey,
  importSigningSecretKey,
  signDetached,
  verifyDetached,
} from "./crypto.js";
export type { KeyPair, SharedKey, SigningKeyPair } from "./crypto.js";
export {
  deriveE2EEV2SessionKeys,
  encryptE2EEV2Frame,
  decryptE2EEV2Frame,
  E2EE_V2_WIRE_OVERHEAD_BYTES,
} from "./e2ee-v2.js";
export type { E2EEV2SessionKeys } from "./e2ee-v2.js";
