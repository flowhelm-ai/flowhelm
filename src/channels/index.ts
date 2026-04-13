/**
 * Channel adapter and channel container exports.
 *
 * Each channel provides a factory function that returns null when
 * the channel's credentials are not configured.
 *
 * Phase 11 adds channel container infrastructure: types, DB writer,
 * HTTP server/client, container manager, and credential reader.
 */

export { TelegramAdapter, createTelegramAdapter } from './telegram/index.js';
export { GmailAdapter, createGmailAdapter } from './gmail/index.js';
export {
  WhatsAppAdapter,
  BaileysTransport,
  useVaultAuthState,
  clearVaultAuthState,
} from './whatsapp/index.js';
export type {
  WhatsAppAdapterOptions,
  WhatsAppTransport,
  VaultAuthState,
} from './whatsapp/index.js';

// Channel container infrastructure (Phase 11)
export type {
  SendRequest,
  SendResponse,
  GwsRequest,
  GwsResponse,
  HealthResponse,
  StatusResponse,
  ChannelStatus,
  ChannelStatusDetail,
  ErrorResponse,
  ChannelContainerConfig,
} from './channel-types.js';
export { ChannelDbWriter, type ChannelDbOptions } from './channel-db.js';
export {
  ChannelServer,
  type ChannelServerOptions,
  type GwsTokenProvider,
} from './channel-server.js';
export { ChannelClient, type ChannelClientOptions } from './channel-client.js';
export { ChannelManager, type ChannelManagerOptions } from './channel-manager.js';
export { readChannelCredentials, type ChannelCredentials } from './credential-reader.js';
