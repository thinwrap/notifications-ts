import type { ChatSendInput } from '../../types';

/**
 * Slack-narrowed extension of `ChatSendInput`. `to` is omitted
 * the webhook URL itself targets the channel, so there is no separate
 * recipient parameter. Baseline `body` and `_passthrough?` are preserved.
 *
 * Per the >=90% baseline-coverage rule, the 10 narrowed fields below
 * cover the most-common Slack Incoming Webhook request parameters. Anything
 * else flows through `_passthrough`.
 */
export interface SlackNarrowedInput extends Omit<ChatSendInput, 'to'> {
  /** Block Kit blocks (preferred over `attachments`). */
  blocks?: SlackBlock[];
  /** Legacy secondary-attachment format. */
  attachments?: SlackAttachment[];
  /** Override default webhook username. */
  username?: string;
  /** Wire key `icon_emoji` (e.g. ':robot_face:'). */
  iconEmoji?: string;
  /** Wire key `icon_url`. */
  iconUrl?: string;
  /** Wire key `thread_ts` (parent message ts for threading). */
  threadTs?: string;
  /** Toggle Slack mrkdwn parsing of `body`. */
  mrkdwn?: boolean;
  /** Wire key `unfurl_links`. */
  unfurlLinks?: boolean;
  /** Wire key `unfurl_media`. */
  unfurlMedia?: boolean;
  /** Wire key `link_names` (resolve @user / #channel). */
  linkNames?: boolean;
}

// Block Kit's full schema is intentionally NOT modeled tightly here. Slack
// publishes 30+ block types with deep nested option arrays; carrying the full
// catalog would inflate the bundle. Consumers wanting strict Block Kit typing
// can use Slack's own `@slack/types` package alongside.
export interface SlackBlock {
  type: string;
  [k: string]: unknown;
}

export interface SlackAttachment {
  color?: string;
  text?: string;
  [k: string]: unknown;
}
