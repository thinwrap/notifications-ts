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
import type { DiscordConfig } from './discord.config';
import type {
  DiscordNarrowedInput,
  DiscordWebhookResponse,
} from './discord.types';

/**
 * Defense-in-depth: the Discord webhook URL IS the credential (its trailing
 * path segment is the secret token). Mirroring the Telegram connector's
 * `redactBotToken`, scrub the webhook URL from any text surfaced through error
 * messages so an underlying fetch error can't leak it into logs or stack
 * traces. Literal (split/join) replacement — a URL is full of regex-special
 * characters, so this is both simpler and safer than a built RegExp.
 */
function redactWebhookUrl(input: string, webhookUrl: string | undefined): string {
  if (!webhookUrl) return input;
  return input.split(webhookUrl).join('<redacted>');
}

/**
 * Webhook-URL-as-auth. No Authorization header; the webhookUrl IS the credential.
 *
 * `?wait=true` is always appended so Discord returns the created message ID in
 * the response body (default behavior is HTTP 204 No Content with no body).
 * `?thread_id=<id>` is appended when `input.threadId` is set — Discord uses a
 * query param, not a body field, to target an existing thread.
 *
 * Retry-After dual-path (outlier, surfaced):
 * Discord historically emits `Retry-After` in MILLISECONDS in the HTTP header,
 * but the body field `retry_after` is in seconds (float, since API v8). The
 * connector parses both paths and normalizes to seconds, surfacing the value
 * informationally — `ConnectorError` carries no `retryAfterSeconds` field; the
 * wrapper performs no retry.
 */
export class DiscordChatConnector
  extends BaseConnector
  implements IChatProvider, IChatConnector
{
  public readonly id = 'discord' as const;
  public readonly channelType = ChannelTypeEnum.CHAT as ChannelTypeEnum.CHAT;

  constructor(private config: DiscordConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IChatConnector`.
   *
   * `to` is intentionally absent from `DiscordNarrowedInput` — the webhook URL
   * targets the channel directly. All snake_case wire keys
   * (`avatar_url`, `allowed_mentions`, `thread_name`) are written explicitly
   * no `Casing` helper is invoked.
   */
  async send(input: DiscordNarrowedInput): Promise<ChatSendResult> {
    if (!this.config.webhookUrl) {
      throw new ConnectorError({
        message:
          'Discord requires `webhookUrl` in config (webhook-URL-as-auth).',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Discord requires `webhookUrl` in config (webhook-URL-as-auth).',
      });
    }

    const connectorBody: Record<string, unknown> = { content: input.body };
    if (input.embeds !== undefined) connectorBody.embeds = input.embeds;
    if (input.components !== undefined) connectorBody.components = input.components;
    if (input.username !== undefined) connectorBody.username = input.username;
    if (input.avatarUrl !== undefined) connectorBody.avatar_url = input.avatarUrl;
    if (input.tts !== undefined) connectorBody.tts = input.tts;
    if (input.flags !== undefined) connectorBody.flags = input.flags;
    if (input.allowedMentions !== undefined) connectorBody.allowed_mentions = input.allowedMentions;
    if (input.threadName !== undefined) connectorBody.thread_name = input.threadName;

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        { 'Content-Type': 'application/json' },
        input._passthrough,
      );

    // `wait=true` is preserved from the brownfield: it tells Discord to return
    // the created message (with id) instead of HTTP 204 No Content.
    const queryParams: Record<string, string> = { wait: 'true', ...mergedQuery };
    if (input.threadId !== undefined) queryParams.thread_id = input.threadId;

    const finalUrl = this.appendQuery(this.config.webhookUrl, queryParams);

    let response: Response;
    try {
      response = await this.fetchImpl(finalUrl, {
        method: 'POST',
        headers: mergedHeaders,
        body: JSON.stringify(mergedBody),
      });
    } catch (error) {
      // redact the webhook URL (the credential) from any surfaced error text.
      const rawMessage = (error as Error).message ?? 'Network error';
      const safeMessage = redactWebhookUrl(rawMessage, this.config.webhookUrl);
      if ((error as Error)?.name === 'AbortError') {
        throw new ConnectorError({
          message: safeMessage,
          statusCode: null,
          providerCode: 'invalid_request',
          cause: error,
        });
      }
      throw new ConnectorError({
        message: safeMessage,
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: error },
      });
    }

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as
        | { code?: number; message?: string; retry_after?: number }
        | null;
      throw this.mapVendorError(response.status, errorBody, response.headers);
    }

    // With `?wait=true`, success is HTTP 200 with the message JSON body. Be
    // defensive against 204 No Content / empty body (e.g., consumer overrode
    // `wait` via _passthrough.query) — return raw=null in that case.
    const raw =
      response.status === 204
        ? null
        : ((await response.json().catch(() => null)) as DiscordWebhookResponse | null);

    return {
      success: true,
      status: 'sent',
      providerMessageId: raw?.id ?? null,
      raw,
    };
  }

  /**
   * HTTP-layer mapping. ConnectorError carries no
   * `retryAfterSeconds` field — retry is consumer policy:
   * parsed seconds embedded in `providerMessage` text; raw header preserved on
   * `cause.retryAfter`; raw body float on `cause.retryAfterBody`. Wrapper
   * performs no retry.
   *
   * 401/403/404 all map to `auth_failed` — invalid, revoked, or
   * deleted webhook URLs are all credential failures.
   *
   * Discord Retry-After dual path (outlier):
   *  - Body `retry_after` (seconds, float, canonical since API v8): prefer; ceil to seconds.
   *  - Header `Retry-After` (legacy, historically ms): heuristic — values > 1000 → ms, else seconds.
   *  See https://discord.com/developers/docs/topics/rate-limits.
   */
  private mapVendorError(
    statusCode: number,
    body: { code?: number; message?: string; retry_after?: number } | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterBody = body?.retry_after;

    // drop the legacy >1000 ms heuristic. Body field is authoritative
    // (seconds, float). Otherwise defer to the shared `parseRetryAfter` for the
    // header (RFC 7231 seconds-or-HTTP-date form).
    let retryAfterSeconds: number | null = null;
    if (retryAfterBody !== undefined) {
      retryAfterSeconds = Math.ceil(retryAfterBody);
    } else if (retryAfterHeader != null) {
      retryAfterSeconds = parseRetryAfter(retryAfterHeader);
    }

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

    const baseMessage = body?.message ?? `Discord HTTP ${statusCode}`;

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

  private appendQuery(url: string, query: Record<string, string>): string {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
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
      content: options.content,
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(`${webhookUrl}?wait=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...passthroughHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // redact the webhook URL (the credential) from any surfaced error text.
      const rawMessage = (error as Error).message ?? 'Network error';
      const safeMessage = redactWebhookUrl(rawMessage, webhookUrl);
      if ((error as Error)?.name === 'AbortError') {
        throw new ConnectorError({
          message: safeMessage,
          statusCode: null,
          providerCode: 'invalid_request',
          cause: error,
        });
      }
      throw new ConnectorError({
        message: safeMessage,
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: error },
      });
    }

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | { code?: number; message?: string; retry_after?: number }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as DiscordWebhookResponse;
    return {
      id: data.id,
      date: new Date().toISOString(),
    };
  }
}
