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
import type { InfobipConfig } from './infobip.config';
import type {
  InfobipNarrowedInput,
  InfobipSendResponse,
  InfobipErrorResponse,
} from './infobip.types';

/** Infobip status group 5 (REJECTED): "rejected by Infobip or the operator". */
const REJECTED_GROUP_ID = 5;

/** Minutes per `validityPeriodTimeUnit`; the v2 endpoint takes minutes only. */
const MINUTES_PER_UNIT = {
  SECONDS: 1 / 60,
  MINUTES: 1,
  HOURS: 60,
  DAYS: 1440,
} as const;

export class InfobipSmsConnector
  extends BaseConnector
  implements ISmsProvider, ISmsConnector
{
  public readonly id = 'infobip';
  public readonly channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(private config: InfobipConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `ISmsConnector`.
   * Builds a JSON body and POSTs to the per-account endpoint
   * `https://<baseUrl>/sms/2/text/advanced`. Authenticates with Infobip's
   * custom `Authorization: App <apiKey>` scheme (not Bearer, not Basic).
   *
   * Infobip wire keys are camelCase (`callbackData`, `notifyUrl`,
   * `validityPeriod`, `bulkId`, `sendAt`, `messageId`);
   * these are written explicitly in the `connectorBody` literal rather than
   * invoking a casing transform.
   *
   * The endpoint answers HTTP 200 even when it refuses the message outright:
   * the per-message `status` then carries group 5 (REJECTED), which is
   * surfaced as a `ConnectorError` rather than a success.
   *
   * Infobip's v2 advanced endpoint takes a `messages: [...]` array even for
   * one message; each message has `destinations: [{ to }]`. The connector
   * wraps `[input.to]` automatically. Multi-recipient batches are out of v1.0
   * Thinwrap baseline — consumers can override
   * `_passthrough.body.messages`.
   */
  async send(input: InfobipNarrowedInput): Promise<SmsSendResult> {
    assertInfobipHost(this.config.baseUrl);
    const from = input.from ?? this.config.from;
    if (!from) {
      throw new ConnectorError({
        message: 'Infobip requires `from` in either input.from or config.from.',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Infobip requires `from` in either input.from or config.from.',
      });
    }

    const messageEntry: Record<string, unknown> = {
      from,
      destinations: [{ to: input.to }],
      text: input.body,
    };
    if (input.callbackData !== undefined)
      messageEntry.callbackData = input.callbackData;
    if (input.notifyUrl !== undefined) messageEntry.notifyUrl = input.notifyUrl;
    if (input.notifyContentType !== undefined)
      messageEntry.notifyContentType = input.notifyContentType;
    if (input.validityPeriod !== undefined) {
      // v2 `validityPeriod` is an integer number of minutes and has no unit
      // field; round up so a converted period is never shorter than asked.
      const perUnit = MINUTES_PER_UNIT[input.validityPeriodTimeUnit ?? 'MINUTES'];
      messageEntry.validityPeriod = Math.ceil(input.validityPeriod * perUnit);
    }
    if (input.flash !== undefined) messageEntry.flash = input.flash;
    if (input.language !== undefined) messageEntry.language = input.language;
    if (input.transliteration !== undefined)
      messageEntry.transliteration = input.transliteration;
    // Scheduling is per message (`messages[].sendAt`); the request root has
    // no send-time field.
    if (input.scheduleSettings?.sendAt !== undefined)
      messageEntry.sendAt = input.scheduleSettings.sendAt;

    const connectorBody: Record<string, unknown> = {
      messages: [messageEntry],
    };
    if (input.bulkId !== undefined) connectorBody.bulkId = input.bulkId;

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        {
          'Content-Type': 'application/json',
          Authorization: `App ${this.config.apiKey}`,
          Accept: 'application/json',
        },
        input._passthrough,
      );

    const baseUrl = `https://${this.config.baseUrl}/sms/2/text/advanced`;

    let response: Response;
    try {
      response = await this.fetchImpl(baseUrl, {
        method: 'POST',
        headers: mergedHeaders,
        body: JSON.stringify(mergedBody),
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
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
        | InfobipErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as InfobipSendResponse;
    const firstMessage = raw.messages?.[0];
    const status = firstMessage?.status;
    if (
      status &&
      (status.groupId === REJECTED_GROUP_ID || status.groupName === 'REJECTED')
    ) {
      throw this.mapRejectedStatus(status, raw, response.status);
    }
    return {
      success: true,
      status: 'sent',
      providerMessageId: firstMessage?.messageId ?? null,
      raw,
    };
  }

  /**
   * Body-layer mapping: HTTP 200 whose message status is in group 5
   * (REJECTED). The status `name` says why: destination / prefix / missing
   * recipient / DND / not-registered rejections are recipient problems,
   * `REJECTED_FLOODING_FILTER` is throttling, and everything else (sender,
   * credits, …) is a request the caller must change.
   */
  private mapRejectedStatus(
    status: InfobipSendResponse['messages'][number]['status'],
    raw: InfobipSendResponse,
    httpStatus: number,
  ): ConnectorError {
    const name = (status.name ?? '').toUpperCase();
    let providerCode: ProviderCode;
    if (
      ['DESTINATION', 'PREFIX', 'MISSING_TO', 'DND', 'NOT_REGISTERED'].some(
        (marker) => name.includes(marker),
      )
    ) {
      providerCode = 'invalid_recipient';
    } else if (name === 'REJECTED_FLOODING_FILTER') {
      providerCode = 'rate_limited';
    } else {
      providerCode = 'invalid_request';
    }

    const message =
      status.description ?? `Infobip rejected the message${name ? ` (${name})` : ''}`;

    return new ConnectorError({
      message,
      statusCode: httpStatus,
      providerCode,
      providerMessage: message,
      cause: { raw, status },
    });
  }

  /**
   * Map Infobip error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header
   * value on `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   *
   * Infobip's body error shape is
   * `{ requestError: { serviceException: { messageId, text } } }`. The
   * `EC_*` `messageId` (e.g., `EC_INVALID_DESTINATION_ADDRESS`) is preserved
   * on `cause.raw` but not individually mapped — HTTP status drives the
   * canonical mapping.
   */
  private mapVendorError(
    statusCode: number,
    body: InfobipErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const serviceException = body?.requestError?.serviceException;
    const text = serviceException?.text;
    const code = serviceException?.messageId;

    let providerCode: ProviderCode;
    if (statusCode === 401 || statusCode === 403) providerCode = 'auth_failed';
    else if (statusCode === 429) providerCode = 'rate_limited';
    else if (statusCode >= 500) providerCode = 'provider_unavailable';
    else if (statusCode >= 400) providerCode = 'invalid_request';
    else providerCode = 'unknown';

    const baseMessage =
      text ?? `Infobip HTTP ${statusCode}${code ? ` ${code}` : ''}`;

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
  // Novu-compatible `sendMessage()` surface
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: ISmsOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    assertInfobipHost(this.config.baseUrl);
    // `/sms/3/messages` is NOT the v2 shape: its message object is
    // `{ sender, destinations: [{ to }], content: { text } }` (Infobip API
    // reference "Send SMS message"; infobip-api-java-client `SmsMessage`
    // `@JsonProperty("sender" | "destinations" | "content")`, `SmsTextContent`
    // `("text")`). v2's `from`/`text` are not v3 fields.
    const sender = options.from ?? this.config.from;
    const message: Record<string, unknown> = {
      destinations: [{ to: options.to }],
      content: { text: options.content },
    };
    if (sender) message.sender = sender;
    const payload: Record<string, unknown> = { messages: [message] };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const url = `https://${this.config.baseUrl}/sms/3/messages`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `App ${this.config.apiKey}`,
          ...passthroughHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
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
        | InfobipErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    // v3 responds 200 with a per-message `status`; group 5 (REJECTED) means
    // the message was not accepted, exactly as on the v2 `.send()` path.
    const data = (await response.json()) as InfobipSendResponse;
    const firstMessage = data.messages?.[0];
    const status = firstMessage?.status;
    if (
      status &&
      (status.groupId === REJECTED_GROUP_ID || status.groupName === 'REJECTED')
    ) {
      throw this.mapRejectedStatus(status, data, response.status);
    }
    return {
      id: firstMessage?.messageId,
      date: new Date().toISOString(),
    };
  }
}

const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * `baseUrl` is the per-account HOSTNAME (`xyz123.api.infobip.com`) that the
 * `App <apiKey>` credential is sent to, interpolated as `https://${baseUrl}/…`.
 * A scheme, path, port, userinfo or trailing slash in it (`evil.example/x`,
 * `user@evil.example`) could move the credential to another host, so only a
 * bare dot-separated DNS name is accepted. The message does not echo the
 * value: a mis-pasted secret could be sitting in it.
 */
function assertInfobipHost(baseUrl: unknown): void {
  if (
    typeof baseUrl === 'string' &&
    baseUrl.length <= 253 &&
    baseUrl.split('.').every((label) => DNS_LABEL.test(label))
  ) {
    return;
  }
  const message =
    'Infobip baseUrl must be a bare hostname such as "xyz123.api.infobip.com" (no scheme, path, port or trailing slash).';
  throw new ConnectorError({
    message,
    statusCode: null,
    providerCode: 'invalid_request',
    providerMessage: message,
  });
}
