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
import type { MsTeamsConfig } from './ms-teams.config';
import { ADAPTIVE_CARD_SCHEMA } from './ms-teams.types';
import type { AdaptiveCard, MsTeamsNarrowedInput } from './ms-teams.types';

/**
 * Webhook-URL-as-auth. No Authorization header; the webhookUrl IS the
 * credential.
 *
 * MS Teams Incoming Webhooks return plain text `'1'` on success (HTTP 200) —
 * non-JSON body parsing throughout. No message identifier is returned, so
 * `providerMessageId` is always `null`.
 *
 * outlier: Teams' Incoming Webhook expects a fixed envelope —
 * `{ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: <card> }] }`.
 * The connector synthesizes this envelope locally; consumers needing legacy
 * MessageCard shapes can override via `_passthrough.body` (deep-merge).
 */
export class MsTeamsChatConnector
  extends BaseConnector
  implements IChatProvider, IChatConnector
{
  public readonly id = 'ms-teams' as const;
  public readonly channelType = ChannelTypeEnum.CHAT as ChannelTypeEnum.CHAT;

  constructor(private config: MsTeamsConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IChatConnector`.
   *
   * `to` is intentionally absent from `MsTeamsNarrowedInput` — the webhook URL
   * targets the channel directly. When `input.card` is unset, the
   * connector synthesizes a default Adaptive Card v1.4 with a single
   * `TextBlock` containing `input.body`. When `input.card` is set, it replaces
   * the synthesized card; `input.body` is NOT auto-inserted as a TextBlock.
   */
  async send(input: MsTeamsNarrowedInput): Promise<ChatSendResult> {
    if (!this.config.webhookUrl) {
      throw new ConnectorError({
        message:
          'MS Teams requires `webhookUrl` in config (webhook-URL-as-auth).',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'MS Teams requires `webhookUrl` in config (webhook-URL-as-auth).',
      });
    }

    const card: AdaptiveCard =
      input.card ?? {
        type: 'AdaptiveCard',
        $schema: ADAPTIVE_CARD_SCHEMA,
        version: '1.4',
        body: [{ type: 'TextBlock', text: input.body, wrap: true }],
      };

    const connectorBody: Record<string, unknown> = {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: card,
        },
      ],
    };

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

    // MS Teams Incoming Webhooks return plain text "1" on success — no JSON,
    // no message id. Use Graph API (Bearer-token auth) for message identifiers.
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
   * Teams-specific quirk: revoked / malformed webhook URLs return HTTP 400
   * with a plain-text body containing `Invalid webhook URL` — not 404 like
   * Slack/Discord. Special-cased to `auth_failed`.
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

    const isInvalidWebhookBody =
      statusCode === 400 && /invalid webhook/i.test(bodyText ?? '');

    const providerCode: ProviderCode = isInvalidWebhookBody
      ? 'auth_failed'
      : statusCode === 401 || statusCode === 403 || statusCode === 404
        ? 'auth_failed'
        : statusCode === 429
          ? 'rate_limited'
          : statusCode === 400
            ? 'invalid_request'
            : statusCode >= 500
              ? 'provider_unavailable'
              : 'unknown';

    const baseMessage = bodyText ?? `MS Teams HTTP ${statusCode}`;

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
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            type: 'AdaptiveCard',
            $schema: ADAPTIVE_CARD_SCHEMA,
            version: '1.4',
            body: [
              {
                type: 'TextBlock',
                text: options.content,
                wrap: true,
              },
            ],
          },
        },
      ],
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
      const errText = await response.text().catch(() => null);
      throw this.mapVendorError(response.status, errText, response.headers);
    }

    return {
      id: undefined,
      date: new Date().toISOString(),
    };
  }
}
