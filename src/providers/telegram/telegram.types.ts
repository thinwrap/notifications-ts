import type { ChatSendInput } from '../../types';

/**
 * Structural Telegram-defined wire shapes (snake_case fields, exactly as
 * sent on the wire). Kept as `Record`-like aliases instead of fully
 * enumerated shapes — Telegram's surface is broad and out-of-baseline
 * fields flow through `_passthrough`.
 */
export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: Record<string, unknown>;
  language?: string;
  custom_emoji_id?: string;
  [k: string]: unknown;
}

export interface TelegramReplyParameters {
  message_id: number;
  chat_id?: number | string;
  allow_sending_without_reply?: boolean;
  quote?: string;
  quote_parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
  quote_entities?: TelegramMessageEntity[];
  quote_position?: number;
  [k: string]: unknown;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
  web_app?: Record<string, unknown>;
  login_url?: Record<string, unknown>;
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
  pay?: boolean;
  [k: string]: unknown;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramLinkPreviewOptions {
  is_disabled?: boolean;
  url?: string;
  prefer_small_media?: boolean;
  prefer_large_media?: boolean;
  show_above_text?: boolean;
}

/**
 * Telegram-narrowed extension of `ChatSendInput`.
 * `to` is required — Telegram has no notion of a "default chat" at the bot
 * level. All other fields are optional. Baseline `ChatSendInput` (`body`,
 * `_passthrough?`) is preserved. Wire keys are derived in
 * `telegram.connector.ts` by hand — no casing middleware.
 */
export interface TelegramNarrowedInput extends ChatSendInput {
  /** REQUIRED — chat_id (numeric string) or '@channelname'. */
  to: string;
  /** Wire key: `parse_mode`. */
  parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown';
  /** Wire key: `entities` (only meaningful when `parseMode` is unset). */
  entities?: TelegramMessageEntity[];
  /** Wire key: `disable_notification`. */
  disableNotification?: boolean;
  /** Wire key: `protect_content`. */
  protectContent?: boolean;
  /** Wire key: `reply_parameters`. */
  replyParameters?: TelegramReplyParameters;
  /** Wire key: `reply_markup`. */
  replyMarkup?: TelegramInlineKeyboardMarkup;
  /** Wire key: `link_preview_options`. */
  linkPreviewOptions?: TelegramLinkPreviewOptions;
  /** Wire key: `message_thread_id` (forum topics). */
  messageThreadId?: number;
}

/**
 * Telegram `sendMessage` response envelope. Both success and error responses
 * share this shape; `ok: false` may be returned with HTTP 200 (soft error) or
 * with a non-2xx status code. `parameters.retry_after` is Telegram's
 * outlier — emitted in the JSON body rather than a `Retry-After` header.
 */
export interface TelegramResponse {
  ok: boolean;
  result?: {
    message_id: number;
    chat?: unknown;
    date?: number;
    text?: string;
    [k: string]: unknown;
  };
  error_code?: number;
  description?: string;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}
