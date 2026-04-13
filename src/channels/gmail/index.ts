/**
 * Gmail channel barrel exports.
 */

export {
  GmailAdapter,
  createGmailAdapter,
  formatEmailForAgent,
  extractSenderName,
} from './adapter.js';
export type { GmailAdapterOptions } from './adapter.js';
export {
  GmailClient,
  parseGmailMessage,
  getHeader,
  decodeBase64Url,
  encodeBase64Url,
  buildRawEmail,
} from './gmail-client.js';
export type {
  ParsedEmail,
  AttachmentMeta,
  GmailMessage,
  GmailClientOptions,
} from './gmail-client.js';
export { PubSubPullDaemon, createServiceAccountJwt } from './pubsub-pull.js';
export type { GmailNotification, PubSubPullOptions } from './pubsub-pull.js';
export { GmailWatchManager } from './watch.js';
export { evaluateFilter, computeImportance, buildFilterRules, isAutomatedEmail } from './filter.js';
export type { EmailFilterRules, FilterResult } from './filter.js';
export { ImapIdleClient, SmtpClient, buildXOAuth2Token } from './imap-client.js';
export { GmailApiTransport } from './transport.js';
export type {
  GmailTransport,
  GmailConnectionState,
  GmailTransportHandlers,
  GmailApiTransportOptions,
} from './transport.js';
