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
import type { GoogleChatConfig } from './google-chat.config';
import type {
  GoogleChatNarrowedInput,
  GoogleChatSendResponse,
} from './google-chat.types';

/**
 * Webhook-URL-as-auth. No Authorization header; the webhookUrl IS the
 * credential. The `?key=<key>&token=<token>` query parameters embedded in the
 * URL are part of the credential surface — forwarded verbatim, never parsed.
 *
 * Google Chat is unusual in the Chat wave for using **camelCase wire keys**
 * (matching Google's API style guide)., all wire keys are
 * written explicitly in object literals; no `Casing` helper is invoked on the
 * new `send()` path. The brownfield `protected casing = CasingEnum.CAMEL_CASE`
 * is preserved only for the legacy `sendMessage()` surface.
 *
 * Unlike Slack/MS Teams (plain-text response), Google Chat returns a full JSON
 * `Message` resource on success; `providerMessageId` carries the full resource
 * name `'spaces/<space-id>/messages/<message-id>'`.
 */
export class GoogleChatChatConnector
  extends BaseConnector
  implements IChatProvider, IChatConnector
{
  public readonly id = 'google-chat' as const;
  public readonly channelType = ChannelTypeEnum.CHAT as ChannelTypeEnum.CHAT;

  constructor(private config: GoogleChatConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IChatConnector`.
   *
   * `to` is intentionally absent from `GoogleChatNarrowedInput` — the webhook
   * URL targets the space directly. All wire keys (`cardsV2`,
   * `thread`, `fallbackText`) are camelCase — written
   * explicitly in the object literal, no transform helper.
   */
  async send(input: GoogleChatNarrowedInput): Promise<ChatSendResult> {
    if (!this.config.webhookUrl) {
      throw new ConnectorError({
        message:
          'Google Chat requires `webhookUrl` in config (webhook-URL-as-auth).',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Google Chat requires `webhookUrl` in config (webhook-URL-as-auth).',
      });
    }

    const connectorBody: Record<string, unknown> = { text: input.body };
    if (input.cardsV2 !== undefined) connectorBody.cardsV2 = input.cardsV2;
    if (input.thread !== undefined) connectorBody.thread = input.thread;
    if (input.fallbackText !== undefined) connectorBody.fallbackText = input.fallbackText;

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        { 'Content-Type': 'application/json; charset=UTF-8' },
        input._passthrough,
      );

    const finalUrl =
      Object.keys(mergedQuery).length > 0
        ? `${this.config.webhookUrl}${this.config.webhookUrl.includes('?') ? '&' : '?'}${new URLSearchParams(mergedQuery).toString()}`
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
      const errorBody = (await response.json().catch(() => null)) as
        | { error?: { code?: number; message?: string; status?: string } }
        | null;
      throw this.mapVendorError(response.status, errorBody, response.headers);
    }

    const raw = (await response.json()) as GoogleChatSendResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.name ?? null,
      raw,
    };
  }

  /**
   * HTTP-layer mapping. ConnectorError carries no
   * `retryAfterSeconds` field — retry is consumer policy:
   * parsed seconds embedded in `providerMessage` text, raw header preserved on
   * `cause.retryAfter`. Wrapper performs no retry.
   *
   * 401/403/404 all map to `auth_failed` — invalid `key`, revoked
   * webhook, or deleted webhook/space are all credential failures.
   */
  private mapVendorError(
    statusCode: number,
    body: { error?: { code?: number; message?: string; status?: string } } | null,
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

    const baseMessage = body?.error?.message ?? `Google Chat HTTP ${statusCode}`;

    const cause: Record<string, unknown> = { raw: body ?? null };
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
      const errBody = (await response.json().catch(() => null)) as
        | { error?: { code?: number; message?: string; status?: string } }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as GoogleChatSendResponse;
    return {
      id: data.name,
      date: new Date().toISOString(),
    };
  }
}
