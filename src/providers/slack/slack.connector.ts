import { BaseConnector } from '../../base/base.connector';
import type {
  IChatOptions,
  IChatProvider,
  ISendMessageSuccessResponse,
  WithPassthrough,
  ChatSendResult,
  IChatConnector,
} from '../../types';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import type { SlackConfig } from './slack.config';
import type { SlackNarrowedInput } from './slack.types';

/**
 * Webhook-URL-as-auth. No Authorization header; the webhookUrl IS the credential.
 *
 * Slack Incoming Webhooks return plain text `"ok"` on success (HTTP 200) and
 * an error string on failure — non-JSON body parsing throughout. No message_id
 * is returned, so `providerMessageId` is always `null`.
 */
export class SlackChatConnector
  extends BaseConnector
  implements IChatProvider, IChatConnector
{
  public readonly id = 'slack' as const;
  public readonly channelType = ChannelTypeEnum.CHAT as ChannelTypeEnum.CHAT;

  constructor(private config: SlackConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IChatConnector`.
   *
   * `to` is intentionally absent from `SlackNarrowedInput` — the webhook URL
   * targets the channel directly. All snake_case wire keys
   * (`icon_emoji`, `icon_url`, `thread_ts`, `unfurl_links`, `unfurl_media`,
   * `link_names`) are written explicitly; no `Casing` helper
   * is invoked.
   */
  async send(input: SlackNarrowedInput): Promise<ChatSendResult> {
    if (!this.config.webhookUrl) {
      throw new ConnectorError({
        message:
          'Slack requires `webhookUrl` in config (webhook-URL-as-auth).',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Slack requires `webhookUrl` in config (webhook-URL-as-auth).',
      });
    }

    const connectorBody: Record<string, unknown> = { text: input.body };
    if (input.blocks !== undefined) connectorBody.blocks = input.blocks;
    if (input.attachments !== undefined) connectorBody.attachments = input.attachments;
    if (input.username !== undefined) connectorBody.username = input.username;
    if (input.iconEmoji !== undefined) connectorBody.icon_emoji = input.iconEmoji;
    if (input.iconUrl !== undefined) connectorBody.icon_url = input.iconUrl;
    if (input.threadTs !== undefined) connectorBody.thread_ts = input.threadTs;
    if (input.mrkdwn !== undefined) connectorBody.mrkdwn = input.mrkdwn;
    if (input.unfurlLinks !== undefined) connectorBody.unfurl_links = input.unfurlLinks;
    if (input.unfurlMedia !== undefined) connectorBody.unfurl_media = input.unfurlMedia;
    if (input.linkNames !== undefined) connectorBody.link_names = input.linkNames;

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        { 'Content-Type': 'application/json' },
        input._passthrough,
      );

    const finalUrl =
      Object.keys(mergedQuery).length > 0
        ? `${this.config.webhookUrl}?${new URLSearchParams(mergedQuery).toString()}`
        : this.config.webhookUrl;

    let response: Response;
    try {
      response = await this.fetchImpl(finalUrl, {
        method: 'POST',
        headers: mergedHeaders,
        body: JSON.stringify(mergedBody),
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        throw new ConnectorError({
          message: (error as Error).message ?? 'Request cancelled',
          statusCode: null,
          providerCode: 'invalid_request',
          cause: error,
        });
      }
      throw new ConnectorError({
        message: (error as Error).message ?? 'Network error',
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: error },
      });
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => null);
      throw this.mapVendorError(response.status, errorBody, response.headers);
    }

    // Slack Incoming Webhooks return plain text "ok" on success — no JSON, no
    // message_id. Use chat.postMessage (Bearer-token auth) for ts-based replies.
    const rawText = await response.text().catch(() => '');
    return {
      success: true,
      status: 'sent',
      providerMessageId: null,
      raw: rawText,
    };
  }

  /**
   * HTTP-layer mapping. ConnectorError carries no
   * `retryAfterSeconds` field — retry is consumer policy:
   * parsed seconds embedded in `providerMessage` text, raw header preserved on
   * `cause.retryAfter`. Wrapper performs no retry.
   *
   * 401/403/404 all map to `auth_failed` — invalid, revoked, or
   * deleted webhook URLs are all credential failures.
   */
  private mapVendorError(
    statusCode: number,
    bodyText: string | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const providerCode: ProviderCode =
      statusCode === 401 || statusCode === 403 || statusCode === 404
        ? 'auth_failed'
        : statusCode === 429
          ? 'rate_limited'
          : statusCode === 400
            ? 'invalid_request'
            : statusCode >= 500
              ? 'provider_unavailable'
              : 'unknown';

    const baseMessage = bodyText ?? `Slack HTTP ${statusCode}`;

    const cause: Record<string, unknown> = { raw: bodyText };
    if (retryAfterHeader != null) cause.retryAfter = retryAfterHeader;
    if (retryAfterSeconds != null) cause.retryAfterSeconds = retryAfterSeconds;

    return new ConnectorError({
      message: baseMessage,
      statusCode,
      providerCode,
      providerMessage: baseMessage,
      cause,
    });
  }

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: IChatOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const webhookUrl = options.webhookUrl ?? this.config.webhookUrl;

    if (!webhookUrl) {
      throw new ConnectorError({
        message:
          'Missing webhook URL: provide webhookUrl in options or config',
        statusCode: 400,
      });
    }

    const payload: Record<string, unknown> = {
      text: options.content,
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...passthroughHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        throw new ConnectorError({
          message: (error as Error).message ?? 'Request cancelled',
          statusCode: null,
          providerCode: 'invalid_request',
          cause: error,
        });
      }
      throw new ConnectorError({
        message: (error as Error).message ?? 'Network error',
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: error },
      });
    }

    if (!response.ok) {
      // brownfield must map 429 → rate_limited and parse Retry-After —
      // route through the canonical mapVendorError for both behaviors.
      const errText = await response.text().catch(() => null);
      throw this.mapVendorError(response.status, errText, response.headers);
    }

    return {
      id: undefined,
      date: new Date().toISOString(),
    };
  }
}
