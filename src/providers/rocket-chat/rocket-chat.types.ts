import type { ChatSendInput } from '../../types';

/**
 * Rocket.Chat-narrowed extension of `ChatSendInput`. The base `to?` is preserved
 * and used as the optional channel override; the connector
 * translates it into Rocket.Chat's wire `channel` field internally. The default
 * channel is bound to the Incoming Webhook URL itself.
 *
 * Per the >=90% baseline-coverage rule, the narrowed fields below
 * cover Rocket.Chat's most-used Incoming Webhook parameters. Anything else
 * flows through `_passthrough`.
 *
 * Rocket.Chat shares Mattermost's Slack-compat attachment shape but diverges on
 * top-level field names — `alias` (not `username`), `avatar` (not `icon_url`),
 * `emoji` (not `icon_emoji`) — reflecting Rocket.Chat's own field-naming choices
 * for the Incoming Webhook payload.
 */
export interface RocketChatNarrowedInput extends ChatSendInput {
  /** Slack-compatible attachment array. Each attachment's camelCase fields
   * are mapped to snake_case wire keys by the connector. */
  attachments?: SlackCompatAttachment[];
  /** Override the webhook's display name (Rocket.Chat's term for Slack's `username`). */
  alias?: string;
  /** Image URL for the message author. */
  avatar?: string;
  /** Slack-style emoji shortcode (e.g. ':robot_face:'). Takes precedence over `avatar`. */
  emoji?: string;
  /** Thread message id — post as a threaded reply to this message. */
  tmid?: string;
  /** When `tmid` is set, also broadcast the reply to the main channel. */
  tshow?: boolean;
}

/**
 * Rocket.Chat adopted Slack's legacy message-attachment format for compatibility.
 * Narrowed-input keys use camelCase; the connector hand-maps the 6 keys
 * requiring snake_case rewrite (explicit per-connector mapping,
 * NOT generic middleware):
 *
 *   authorName  → author_name
 *   authorLink  → author_link
 *   authorIcon  → author_icon
 *   titleLink   → title_link
 *   imageUrl    → image_url
 *   thumbUrl    → thumb_url
 *
 * Re-declared locally (not imported from Mattermost) — shared types
 * create implicit coupling that breaks when one provider's wire shape diverges.
 */
export interface SlackCompatAttachment {
  color?: string;
  pretext?: string;
  authorName?: string;
  authorLink?: string;
  authorIcon?: string;
  title?: string;
  titleLink?: string;
  text?: string;
  fields?: Array<{ title: string; value: string; short?: boolean }>;
  imageUrl?: string;
  thumbUrl?: string;
  footer?: string;
  timestamp?: number | string;
  fallback?: string;
  [k: string]: unknown;
}
