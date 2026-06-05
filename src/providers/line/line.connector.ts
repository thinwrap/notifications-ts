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
import type { LineConfig } from './line.config';
import type {
  LineNarrowedInput,
  LineMessage,
  LineSendResponse,
} from './line.types';

/**
 * Token-auth chat connector. Authorization is a Bearer header
 * carrying a long-lived Channel Access Token from the LINE Developers Console.
 * Endpoint pinned to LINE's Push API (`POST /v2/bot/message/push`) — Reply,
 * Multicast, Broadcast, and Narrowcast APIs are out-of-scope for v1.0.
 *
 * Brownfield `sendMessage()` is preserved verbatim alongside the new `.send()`
 * for's Novu provider-interface wrap.
 */
export class LineChatConnector
  extends BaseConnector
  implements IChatProvider, IChatConnector
{
  public readonly id = 'line' as const;
  public readonly channelType = ChannelTypeEnum.CHAT as ChannelTypeEnum.CHAT;

  constructor(
    private config: LineConfig,
    fetchImpl?: typeof fetch,
  ) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IChatConnector`.
   *
   * Builds a JSON body for LINE's `POST /v2/bot/message/push` endpoint with
   * hand-mapped camelCase wire keys (no casing middleware).
   * LINE's published API style is camelCase end-to-end, so the wire keys
   * match the narrowed-input field names verbatim.
   *
   * Body-vs-messages contract: when `input.messages` is set, `input.body` is
   * **ignored** (the wire payload uses `input.messages` directly). When unset,
   * the connector synthesizes `messages: [{ type: 'text', text: input.body }]`
   * — the minimal `body: string` → `messages: LineMessage[]` bridge.
   */
  async send(input: LineNarrowedInput): Promise<ChatSendResult> {
    if (!input.to) {
      throw new ConnectorError({
        message: 'LINE requires `to`',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'LINE requires `to` (userId / groupId / roomId).',
        cause: null,
      });
    }

    // `body → messages[]` synthesis: when input.messages is unset, wrap
    // input.body as a single text message. When set, input.body is ignored.
    const messages: LineMessage[] =
      input.messages ?? [{ type: 'text', text: input.body }];

    const connectorBody: Record<string, unknown> = {
      to: input.to,
      messages,
    };
    if (input.notificationDisabled !== undefined)
      connectorBody.notificationDisabled = input.notificationDisabled;
    if (input.customAggregationUnits !== undefined)
      connectorBody.customAggregationUnits = input.customAggregationUnits;

    const { body: mergedBody, headers: mergedHeaders } = mergePassthrough<
      Record<string, unknown>
    >(
      connectorBody,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.channelAccessToken}`,
      },
      input._passthrough,
    );

    const url = 'https://api.line.me/v2/bot/message/push';

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
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
      const errBody = (await response.json().catch(() => null)) as
        | {
            message?: string;
            details?: Array<{ message?: string; property?: string }>;
          }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as LineSendResponse;
    // LINE Push API returns { sentMessages: [{ id, quoteToken? }, ...] } — one
    // entry per message in the request. Surface the first sentMessage.id as
    // providerMessageId (single-recipient API call → still meaningful).
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.sentMessages?.[0]?.id ?? null,
      raw,
    };
  }

  /**
   * HTTP-layer mapping. ConnectorError carries no
   * `retryAfterSeconds` field — retry is consumer policy:
   * parsed seconds embedded in `providerMessage` text, raw header preserved on
   * `cause.retryAfter`. Wrapper performs no retry.
   *
   * LINE returns rich error details under `body.details` for some 400 cases.
   * The connector surfaces `body.message` (top-level summary) in
   * `providerMessage`; consumers can read `cause.body.details` for per-property
   * specifics.
   *
   * Status → ProviderCode table:
   *   401                                      → auth_failed
   *   403                                      → auth_failed
   *   400 + body.message matches /not found/i  → invalid_recipient
   *   400 + body.message matches /userId/i     → invalid_recipient
   *   400 (other)                              → invalid_request
   *   429                                      → rate_limited
   *   5xx                                      → provider_unavailable
   *   other                                    → unknown
   */
  private mapVendorError(
    statusCode: number,
    body: {
      message?: string;
      details?: Array<{ message?: string; property?: string }>;
    } | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    // Use shared parseRetryAfter (RFC 7231 + HTTP-date support).
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const message = body?.message;
    const isNotFoundRecipient =
      statusCode === 400 && /not found/i.test(message ?? '');
    const isInvalidUserId =
      statusCode === 400 && /(userId|user id)/i.test(message ?? '');

    const providerCode: ProviderCode =
      statusCode === 401
        ? 'auth_failed'
        : statusCode === 403
          ? 'auth_failed'
          : isNotFoundRecipient || isInvalidUserId
            ? 'invalid_recipient'
            : statusCode === 400
              ? 'invalid_request'
              : statusCode === 429
                ? 'rate_limited'
                : statusCode >= 500
                  ? 'provider_unavailable'
                  : 'unknown';

    const baseMessage = message ?? `LINE HTTP ${statusCode}`;

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
    const payload: Record<string, unknown> = {
      to: options.channel,
      messages: [{ type: 'text', text: options.content }],
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.channelAccessToken}`,
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
        | { message?: string; details?: Array<{ message?: string; property?: string }> }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as LineSendResponse;
    return {
      id: data.sentMessages[0]!.id,
      date: new Date().toISOString(),
    };
  }
}
