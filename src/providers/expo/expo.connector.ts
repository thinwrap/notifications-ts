import { BaseConnector } from '../../base/base.connector';
import type {
  IPushOptions,
  IPushProvider,
  ISendMessageSuccessResponse,
  WithPassthrough,
  PushSendResult,
  IPushConnector,
} from '../../types';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import type { ExpoConfig } from './expo.config';
import type {
  ExpoNarrowedInput,
  ExpoSendResponse,
  ExpoTicket,
} from './expo.types';

const EXPO_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/**
 * Body-layer ticket-error mapping. Expo returns HTTP 200 even when individual
 * tickets fail; `data[].details.error` is the source of truth. Falls back to
 * `'unknown'` for unmapped error codes.
 */
const EXPO_TICKET_ERROR_TO_PROVIDER_CODE: Record<string, ProviderCode> = {
  DeviceNotRegistered: 'invalid_recipient',
  MessageTooBig: 'invalid_request',
  MessageRateExceeded: 'rate_limited',
  MismatchSenderId: 'auth_failed',
  InvalidCredentials: 'auth_failed',
};

export class ExpoPushConnector
  extends BaseConnector
  implements IPushProvider, IPushConnector
{
  public readonly id = 'expo';
  public readonly channelType = ChannelTypeEnum.PUSH as ChannelTypeEnum.PUSH;

  constructor(private config: ExpoConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IPushConnector`.
   * Builds a JSON body in camelCase wire shape (Expo's API is camelCase
   * native — no casing transform needed), optionally adds Bearer auth, and
   * POSTs to the single Expo push endpoint.
   *
   * Single-recipient enforcement — multi-target batching is not
   * exposed on the unified surface. Consumers needing batched sends use the
   * brownfield `sendMessage()` surface or pass an array via
   * `_passthrough.body`.
   *
   * Expo emits HTTP 200 even for soft errors — `data.status` is inspected
   * after the HTTP layer; `status: 'error'` is mapped via
   * `EXPO_TICKET_ERROR_TO_PROVIDER_CODE` to a canonical `ConnectorError`.
   */
  async send(input: ExpoNarrowedInput): Promise<PushSendResult> {
    const connectorBody: Record<string, unknown> = { to: input.to };
    if (input.title !== undefined) connectorBody.title = input.title;
    if (input.body !== undefined) connectorBody.body = input.body;
    if (input.data !== undefined) connectorBody.data = input.data;
    if (input.sound !== undefined) connectorBody.sound = input.sound;
    if (input.badge !== undefined) connectorBody.badge = input.badge;
    if (input.ttl !== undefined) connectorBody.ttl = input.ttl;
    if (input.priority !== undefined) connectorBody.priority = input.priority;
    if (input.channelId !== undefined) connectorBody.channelId = input.channelId;
    if (input.categoryId !== undefined) connectorBody.categoryId = input.categoryId;
    if (input.mutableContent !== undefined)
      connectorBody.mutableContent = input.mutableContent;
    if (input.subtitle !== undefined) connectorBody.subtitle = input.subtitle;
    if (input.interruptionLevel !== undefined)
      connectorBody.interruptionLevel = input.interruptionLevel;
    if (input._displayInForeground !== undefined)
      connectorBody._displayInForeground = input._displayInForeground;

    const connectorHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.config.accessToken) {
      connectorHeaders.Authorization = `Bearer ${this.config.accessToken}`;
    }

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        connectorHeaders,
        input._passthrough,
      );

    let response: Response;
    try {
      response = await this.fetchImpl(EXPO_ENDPOINT, {
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
        | { errors?: { message?: string }[] }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as ExpoSendResponse;
    const ticket: ExpoTicket | undefined = Array.isArray(raw.data)
      ? raw.data[0]
      : raw.data;

    if (!ticket) {
      throw new ConnectorError({
        message: 'Expo response missing `data` ticket.',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Expo response missing `data` ticket.',
        cause: raw,
      });
    }

    if (ticket.status === 'error') {
      throw this.mapTicketError(ticket, raw, response.status);
    }

    return {
      success: true,
      status: 'sent',
      providerMessageId: ticket.id ?? null,
      raw,
    };
  }

  /**
   * Body-layer mapping: HTTP 200 with `data.status === 'error'`. Expo
   * ticket-level rate-limit errors (`MessageRateExceeded`) arrive on HTTP 200
   * with no `Retry-After` header — that's an HTTP-layer concern handled in
   * `mapVendorError`.
   */
  private mapTicketError(
    ticket: ExpoTicket,
    raw: ExpoSendResponse,
    httpStatus: number,
  ): ConnectorError {
    const errorCode = ticket.details?.error;
    const mapped = errorCode
      ? EXPO_TICKET_ERROR_TO_PROVIDER_CODE[errorCode]
      : undefined;
    const providerCode: ProviderCode = mapped ?? 'unknown';
    const message = ticket.message ?? `Expo ticket error: ${errorCode ?? 'unknown'}`;
    return new ConnectorError({
      message,
      statusCode: httpStatus,
      providerCode,
      providerMessage: message,
      cause: { raw },
    });
  }

  /**
   * HTTP-layer mapping. Parses `Retry-After` and embeds
   * the parsed seconds in `providerMessage` text; raw header value is attached
   * to `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field) — the wrapper performs no retry.
   */
  private mapVendorError(
    status: number,
    body: { errors?: { message?: string }[] } | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const providerCode: ProviderCode =
      status === 401
        ? 'auth_failed'
        : status === 429
          ? 'rate_limited'
          : status >= 500
            ? 'provider_unavailable'
            : status >= 400
              ? 'invalid_request'
              : 'unknown';

    const firstErrorMessage = body?.errors?.[0]?.message;
    const baseMessage = firstErrorMessage ?? `Expo HTTP ${status}`;

    const cause: Record<string, unknown> = { raw: body ?? null };
    if (retryAfterHeader != null) cause.retryAfter = retryAfterHeader;
    if (retryAfterSeconds != null) cause.retryAfterSeconds = retryAfterSeconds;

    return new ConnectorError({
      message: baseMessage,
      statusCode: status,
      providerCode,
      providerMessage: baseMessage,
      cause,
    });
  }

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: IPushOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const overrides = options.overrides ?? {};

    const messages = options.target.map((token) => {
      const message: Record<string, unknown> = {
        to: token,
        title: overrides.title ?? options.title,
        body: overrides.body ?? options.content,
      };

      if (options.payload && Object.keys(options.payload).length > 0) {
        message.data = options.payload;
      }

      if (overrides.sound !== undefined) message.sound = overrides.sound;
      if (overrides.badge !== undefined) message.badge = overrides.badge;

      return message;
    });

    const { body: transformedBody, headers: passthroughHeaders } = mergePassthrough(
      messages.length === 1 ? messages[0]! : {},
      {},
      bridgeProviderData._passthrough,
    );

    const requestBody =
      messages.length === 1
        ? { ...messages[0], ...transformedBody }
        : messages;

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...passthroughHeaders,
    };

    if (this.config.accessToken) {
      requestHeaders.Authorization = `Bearer ${this.config.accessToken}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(EXPO_ENDPOINT, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
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
      // brownfield must parse Retry-After on 429 too — route through mapVendorError.
      const errBody = (await response.json().catch(() => null)) as
        | { errors?: { message?: string }[] }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as ExpoSendResponse;
    const tickets: ExpoTicket[] = Array.isArray(data.data)
      ? data.data
      : [data.data];
    const ids: string[] = [];
    let allFailed = true;

    for (const ticket of tickets) {
      if (ticket.status === 'ok') {
        ids.push(ticket.id!);
        allFailed = false;
      } else {
        ids.push(ticket.message ?? ticket.details?.error ?? 'Expo push failed');
      }
    }

    if (allFailed) {
      throw new ConnectorError({
        message: `All ${options.target.length} Expo push message(s) failed`,
        statusCode: 500,
        providerMessage: ids.join('; '),
      });
    }

    return {
      ids,
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

