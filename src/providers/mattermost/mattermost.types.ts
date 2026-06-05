import type { ChatSendInput } from '../../types';

/**
 * Mattermost-narrowed extension of `ChatSendInput`. The base `to?` is preserved
 * and used as the optional channel override; the connector
 * translates it into Mattermost's wire `channel` field internally. The default
 * channel is bound to the Incoming Webhook URL itself.
 *
 * Per the >=90% baseline-coverage rule, the narrowed fields below
 * cover Mattermost's most-used Incoming Webhook parameters. Anything else
 * flows through `_passthrough`.
 *
 * Channel-override caveat: `to` (translated to wire `channel`) and likewise
 * `username`/`iconUrl`/`iconEmoji` are silently ignored by Mattermost unless
 * the server admin has enabled "Enable integrations to override usernames /
 * icons / channels" (System Console → Integrations → Custom Integrations).
 * The connector surfaces no warning when overrides are blocked server-side.
 */
export interface MattermostNarrowedInput extends ChatSendInput {
  /** Slack-compatible attachment array. Each attachment's camelCase fields
   * are mapped to snake_case wire keys by the connector. */
  attachments?: SlackCompatAttachment[];
  /** Override the webhook's default username (server-config gated). */
  username?: string;
  /** Wire key `icon_url` (server-config gated). */
  iconUrl?: string;
  /** Wire key `icon_emoji` (e.g. ':robot_face:'; server-config gated). */
  iconEmoji?: string;
  /** Custom message properties — Mattermost plugin / integration surface. */
  props?: Record<string, unknown>;
  /** Post type override (e.g. 'system_join_channel'). */
  type?: string;
}

/**
 * Mattermost adopted Slack's legacy message-attachment format verbatim for
 * compatibility. Narrowed-input keys use camelCase; the connector hand-maps
 * the 7 keys requiring snake_case rewrite (explicit per-
 * connector mapping, NOT generic middleware):
 *
 *   authorName  → author_name
 *   authorLink  → author_link
 *   authorIcon  → author_icon
 *   titleLink   → title_link
 *   imageUrl    → image_url
 *   thumbUrl    → thumb_url
 *   footerIcon  → footer_icon
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
  footerIcon?: string;
  timestamp?: number | string;
  fallback?: string;
  [k: string]: unknown;
}
