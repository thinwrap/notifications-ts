import { BaseConnector } from '../../base/base.connector';
import type {
  ISmsOptions,
  ISmsProvider,
  ISendMessageSuccessResponse,
  WithPassthrough,
  SmsSendResult,
  ISmsConnector,
} from '../../types';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import type { VonageConfig } from './vonage.config';
import type { VonageNarrowedInput, VonageSmsResponse } from './vonage.types';

const VONAGE_ENDPOINT = 'https://rest.nexmo.com/sms/json';

/**
 * Body-layer status-code mapping. Vonage emits HTTP 200
 * even for soft errors — `messages[0].status` is the source of truth.
 * Falls back to `'unknown'` for unmapped statuses.
 */
const VONAGE_STATUS_TO_PROVIDER_CODE: Record<string, ProviderCode> = {
  '0': 'unknown', // success — never reaches this map; placeholder for completeness
  '1': 'rate_limited', // Throttled
  '2': 'invalid_request', // Missing params
  '3': 'invalid_request', // Invalid params
  '4': 'auth_failed', // Invalid credentials
  '5': 'provider_unavailable', // Internal error
  '6': 'invalid_request', // Invalid message
  '7': 'invalid_recipient', // Number barred
  '8': 'auth_failed', // Partner account barred
  '9': 'auth_failed', // Partner quota exceeded
  '11': 'invalid_request', // Account not enabled for REST
  '12': 'invalid_request', // Message too long
  '13': 'invalid_request', // Communication failed
  '14': 'invalid_request', // Invalid signature
  '15': 'invalid_request', // Invalid sender address (from)
  '16': 'invalid_request', // Invalid TTL
  '19': 'invalid_request', // Facility not allowed
  '20': 'invalid_request', // Invalid message class
  '23': 'invalid_request', // Bad callback :: missing protocol
  '29': 'invalid_recipient', // Non-Whitelisted Destination
  '34': 'invalid_recipient', // Invalid Phone Number
};

// Registered under both 'vonage' (canonical) and 'nexmo' (Novu legacy alias) in ProviderConfigMap.
export class VonageSmsConnector
  extends BaseConnector
  implements ISmsProvider, ISmsConnector
{
  public readonly id = 'vonage';
  public readonly channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(private config: VonageConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `ISmsConnector`.
   * Builds a form-urlencoded body (Vonage is one of the few wrapped providers
   * that auths via form fields instead of HTTP headers) and POSTs to
   * `https://rest.nexmo.com/sms/json`.
   *
   * Wire keys are kebab-case (`client-ref`, `message-class`, `status-report-req`)
   * which does not match camelCase auto-derivation; the connector
   * writes them explicitly in the `connectorBody` literal rather than invoking
   * any casing transform.
   *
   * Vonage emits HTTP 200 even for soft errors — `messages[0].status` is the
   * source of truth. The connector inspects `message.status` after the
   * HTTP layer; non-`'0'` is mapped via `VONAGE_STATUS_TO_PROVIDER_CODE` to a
   * canonical `ConnectorError`.
   */
  async send(input: VonageNarrowedInput): Promise<SmsSendResult> {
    const from = input.from ?? this.config.from;
    if (!from) {
      throw new ConnectorError({
        message: 'Vonage requires `from` in either input.from or config.from.',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Vonage requires `from` in either input.from or config.from.',
      });
    }

    const connectorBody: Record<string, string> = {
      api_key: this.config.apiKey,
      api_secret: this.config.apiSecret,
      from,
      to: input.to,
      text: input.body,
    };
    if (input.clientRef !== undefined) {
      connectorBody['client-ref'] = input.clientRef;
    }
    if (input.messageClass !== undefined) {
      connectorBody['message-class'] = String(input.messageClass);
    }
    if (input.type !== undefined) {
      connectorBody.type = input.type;
    }
    if (input.statusReportReq !== undefined) {
      connectorBody['status-report-req'] = String(input.statusReportReq);
    }
    if (input.ttl !== undefined) {
      connectorBody.ttl = String(input.ttl);
    }
    if (input.callback !== undefined) {
      connectorBody.callback = input.callback;
    }

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        input._passthrough,
      );

    // Form-encode the merged body. Passthrough values may be non-string; coerce
    // via String() to keep `URLSearchParams` happy.
    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(mergedBody)) {
      if (value === undefined || value === null) continue;
      formBody.append(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(VONAGE_ENDPOINT, {
        method: 'POST',
        headers: mergedHeaders,
        body: formBody.toString(),
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

    const raw = (await response.json()) as VonageSmsResponse;
    const message = raw.messages?.[0];

    if (!message) {
      throw new ConnectorError({
        message: 'Vonage response missing `messages[0]`.',
        statusCode: response.status,
        providerCode: 'unknown',
        providerMessage: 'Vonage response missing `messages[0]`.',
        cause: raw,
      });
    }

    if (message.status !== '0') {
      throw this.mapVonageStatus(
        message.status,
        message['error-text'],
        raw,
        response.status,
      );
    }

    return {
      success: true,
      status: 'sent',
      providerMessageId: message['message-id'] ?? null,
      raw,
    };
  }

  /**
   * Body-layer mapping: HTTP 200 with non-`'0'` per-message status. Soft-rate-limit
   * (status `'1'`) does not carry a `Retry-After` header — that's an HTTP-layer
   * concern handled in `mapVendorError`.
   */
  private mapVonageStatus(
    status: string,
    errorText: string | undefined,
    raw: VonageSmsResponse,
    httpStatus: number,
  ): ConnectorError {
    const providerCode = VONAGE_STATUS_TO_PROVIDER_CODE[status] ?? 'unknown';
    const message = errorText ?? `Vonage status ${status}`;
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
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    statusCode: number,
    body: string | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const providerCode: ProviderCode =
      statusCode === 401 || statusCode === 403
        ? 'auth_failed'
        : statusCode === 429
          ? 'rate_limited'
          : statusCode >= 500
            ? 'provider_unavailable'
            : statusCode >= 400
              ? 'invalid_request'
              : 'unknown';

    const baseMessage = body ?? `Vonage HTTP ${statusCode}`;

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
    options: ISmsOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    // Vonage's wire API is snake_case (`api_key`, `api_secret`,
    // `from`, `to`, `text`). The previous shim's CAMEL_CASE transform was wrong —
    // hand-build the body in snake_case and merge passthrough verbatim.
    const payload: Record<string, unknown> = {
      api_key: this.config.apiKey,
      api_secret: this.config.apiSecret,
      to: options.to,
      from: options.from ?? this.config.from,
      text: options.content,
    };

    const { body, headers } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(VONAGE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...headers,
        },
        body: params.toString(),
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
      const errBody = await response.text().catch(() => null);
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as VonageSmsResponse;
    const message = data.messages[0]!;

    if (message.status !== '0') {
      throw this.mapVonageStatus(
        message.status,
        message['error-text'],
        data,
        response.status,
      );
    }

    return {
      id: message['message-id'],
      date: new Date().toISOString(),
    };
  }
}
