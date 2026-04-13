/**
 * Telegram channel — barrel exports.
 */

export {
  TelegramAdapter,
  createTelegramAdapter,
  parseTelegramChatId,
  escapeMarkdownV2,
  stripMarkdown,
  splitMessage,
} from './adapter.js';

export type { TelegramAdapterOptions } from './adapter.js';

export { GrammyTransport } from './transport.js';
export type {
  TelegramTransport,
  TelegramTransportMessage,
  TelegramSendOptions,
  TelegramConnectionState,
  TelegramTransportHandlers,
  GrammyTransportOptions,
} from './transport.js';
