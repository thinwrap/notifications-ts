import type { ChatSendInput } from '../../types';

/**
 * LINE-narrowed extension of `ChatSendInput`. `to` is REQUIRED — LINE returns
 * a `userId` / `groupId` / `roomId` from webhook events that the bot then
 * addresses for unsolicited push messages.
 *
 * `messages` is OPTIONAL. When unset, `line.connector.ts` synthesizes a single
 * text message from `input.body` (the documented `body → messages[]` bridge
 * ). When set, `input.body` is **ignored** — same precedence as
 * WhatsApp Business 1.35's template/interactive overrides.
 *
 * Per the >=90% baseline-coverage rule, the narrowed fields below
 * cover the two highest-value LINE Push extras (`notificationDisabled`,
 * `customAggregationUnits`) plus the eight Message-object variants enumerated
 * by `LineMessage`. Out-of-baseline fields flow through `_passthrough` per
 * .
 */
export interface LineNarrowedInput extends ChatSendInput {
  /** REQUIRED — userId / groupId / roomId from a LINE webhook event. */
  to: string;
  /**
   * Up to 5 messages per API call per LINE limits. When set, overrides the
   * body-as-text synthesis path; `input.body` is ignored.
   */
  messages?: LineMessage[];
  /** Wire key `notificationDisabled` — suppress push notification on recipient device. */
  notificationDisabled?: boolean;
  /** Wire key `customAggregationUnits` — analytics aggregation labels (up to 3). */
  customAggregationUnits?: string[];
}

/**
 * Discriminated union over LINE's documented Message-object surface. The eight
 * variants match LINE's published Messaging API types (text, sticker, image,
 * video, audio, location, flex, template). The Flex `contents` field is typed
 * loosely (`Record<string, unknown>`) because LINE's Flex JSON schema is deeply
 * nested and tight modeling would inflate the bundle — consumers wanting tight
 * Flex typing can use LINE's official `@line/bot-sdk` types alongside.
 */
export type LineMessage =
  | LineTextMessage
  | LineStickerMessage
  | LineImageMessage
  | LineVideoMessage
  | LineAudioMessage
  | LineLocationMessage
  | LineFlexMessage
  | LineTemplateMessage;

export interface LineTextMessage {
  type: 'text';
  text: string;
  /** Wire key `quoteToken` — quote an earlier user message. */
  quoteToken?: string;
  emojis?: Array<{ index: number; productId: string; emojiId: string }>;
  quickReply?: { items: Array<Record<string, unknown>> };
  sender?: { name?: string; iconUrl?: string };
}

export interface LineStickerMessage {
  type: 'sticker';
  packageId: string;
  stickerId: string;
  quickReply?: unknown;
  sender?: unknown;
}

export interface LineImageMessage {
  type: 'image';
  originalContentUrl: string;
  previewImageUrl: string;
  quickReply?: unknown;
  sender?: unknown;
}

export interface LineVideoMessage {
  type: 'video';
  originalContentUrl: string;
  previewImageUrl: string;
  trackingId?: string;
  quickReply?: unknown;
  sender?: unknown;
}

export interface LineAudioMessage {
  type: 'audio';
  originalContentUrl: string;
  duration: number;
  quickReply?: unknown;
  sender?: unknown;
}

export interface LineLocationMessage {
  type: 'location';
  title: string;
  address: string;
  latitude: number;
  longitude: number;
  quickReply?: unknown;
  sender?: unknown;
}

export interface LineFlexMessage {
  type: 'flex';
  altText: string;
  contents: Record<string, unknown>;
  quickReply?: unknown;
  sender?: unknown;
}

export interface LineTemplateMessage {
  type: 'template';
  altText: string;
  template: Record<string, unknown>;
  quickReply?: unknown;
  sender?: unknown;
}

/**
 * LINE Push API response envelope. Success path emits one `sentMessages` entry
 * per message in the request, each carrying a server-assigned `id` and an
 * optional `quoteToken` (for use as `quoteToken` on a subsequent text message).
 */
export interface LineSendResponse {
  sentMessages: Array<{ id: string; quoteToken?: string }>;
}
