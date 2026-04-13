/**
 * WhatsApp channel — barrel exports.
 */

export { WhatsAppAdapter, parseWhatsAppJid, splitMessage } from './adapter.js';
export type { WhatsAppAdapterOptions } from './adapter.js';

export { BaileysTransport } from './transport.js';
export type {
  WhatsAppTransport,
  TransportMessage,
  TransportSendContent,
  TransportConnectionState,
  TransportEventHandlers,
  BaileysTransportOptions,
} from './transport.js';

export { useVaultAuthState, clearVaultAuthState } from './auth-state.js';
export type { VaultAuthState, VaultAuthStateOptions } from './auth-state.js';
