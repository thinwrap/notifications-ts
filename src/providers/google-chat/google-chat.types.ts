import type { ChatSendInput } from '../../types';

/**
 * Google-Chat-narrowed extension of `ChatSendInput`. `to` is omitted
 * the webhook URL itself targets the space, so there is no separate
 * recipient parameter. Baseline `body` and `_passthrough?` are preserved.
 *
 * Per the >=90% baseline-coverage rule, the 3 narrowed fields cover
 * Google Chat's most-common Incoming Webhook request parameters. Anything else
 * flows through `_passthrough`.
 */
export interface GoogleChatNarrowedInput extends Omit<ChatSendInput, 'to'> {
  /** Cards v2 — Google Chat's current canonical rich-content format. */
  cardsV2?: GoogleChatCardV2[];
  /** Wire key `thread.name` (message threading inside a space). */
  thread?: { name: string };
  /**
   * Wire key `fallbackText` (camelCase per Google Chat REST API as of
   * 2024-2025). Accessibility / screen-reader fallback when only cards present.
   */
  fallbackText?: string;
}

export interface GoogleChatCardV2 {
  cardId: string;
  card: GoogleChatCard;
}

// Google's Cards v2 widget catalog (~20 widget types with deep nested option
// arrays) is intentionally NOT modeled tightly here. Carrying the full catalog
// would inflate the bundle; the loose shape lets consumers pass canonical
// Google Chat JSON. Consumers wanting strict Cards v2 typing can use Google's
// own `@googleapis/chat` package alongside (the `chat_v1.Schema$Card` export).
export interface GoogleChatCard {
  header?: {
    title?: string;
    subtitle?: string;
    imageUrl?: string;
    imageType?: 'SQUARE' | 'CIRCLE';
    imageAltText?: string;
  };
  sections?: Array<{
    header?: string;
    collapsible?: boolean;
    uncollapsibleWidgetsCount?: number;
    widgets?: Array<Record<string, unknown>>;
  }>;
  cardActions?: Array<{ actionLabel: string; onClick: Record<string, unknown> }>;
  name?: string;
}

/**
 * Google Chat returns full JSON on success (unlike Slack/MS Teams which return
 * plain text). The `name` field is the full resource name
 * `'spaces/<space-id>/messages/<message-id>'` — the connector surfaces this
 * verbatim on `providerMessageId`.
 */
export interface GoogleChatSendResponse {
  name?: string;
  sender?: { name: string; type?: 'HUMAN' | 'BOT' };
  text?: string;
  thread?: { name: string };
  createTime?: string;
  [k: string]: unknown;
}
