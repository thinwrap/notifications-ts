import type { ChatSendInput } from '../../types';

/**
 * Discord-narrowed extension of `ChatSendInput`. `to` is omitted
 * the webhook URL itself targets the channel, so there is no separate
 * recipient parameter. Baseline `body` and `_passthrough?` are preserved.
 *
 * Per the >=90% baseline-coverage rule, the 9 narrowed fields below
 * cover Discord's most-used Incoming Webhook request parameters. Anything else
 * flows through `_passthrough`.
 *
 * `DiscordEmbed` and `DiscordActionRow` are modeled at a useful granularity
 * (covers ~95% of consumer use cases). Full embeds spec is at
 * https://discord.com/developers/docs/resources/channel#embed-object.
 */
export interface DiscordNarrowedInput extends Omit<ChatSendInput, 'to'> {
  /** Up to 10 rich embeds. */
  embeds?: DiscordEmbed[];
  /** Message components (buttons, selects, text inputs). */
  components?: DiscordActionRow[];
  /** Override webhook's default username. */
  username?: string;
  /** Wire key `avatar_url` (override webhook's default avatar). */
  avatarUrl?: string;
  /** Text-to-speech flag. */
  tts?: boolean;
  /** Bitfield: 4 = SUPPRESS_EMBEDS, 4096 = SUPPRESS_NOTIFICATIONS. */
  flags?: number;
  /** Wire key `allowed_mentions` (controls who can be pinged). */
  allowedMentions?: DiscordAllowedMentions;
  /** Wire key `thread_name` (creates a new thread in a forum channel). */
  threadName?: string;
  /** Appended as `?thread_id=<id>` query parameter (targets an existing thread). */
  threadId?: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface DiscordActionRow {
  /** 1 = action row. */
  type: 1;
  /** button=2, select=3, text-input=4. */
  components: Array<{ type: 2 | 3 | 4; [k: string]: unknown }>;
}

export interface DiscordAllowedMentions {
  parse?: Array<'roles' | 'users' | 'everyone'>;
  roles?: string[];
  users?: string[];
  replied_user?: boolean;
}

export interface DiscordWebhookResponse {
  id?: string;
  type?: number;
  content?: string;
  channel_id?: string;
  [k: string]: unknown;
}
