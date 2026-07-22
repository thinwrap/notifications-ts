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
   * `validityPeriod`, `bulkId`, `sendingDateTime`, `messageId`);
   * these are written explicitly in the `connectorBody` literal rather than
   * invoking a casing transform.
   *
   * Infobip's v2 advanced endpoint takes a `messages: [...]` array even for
   * one message; each message has `destinations: [{ to }]`. The connector
   * wraps `[input.to]` automatically. Multi-recipient batches are out of v1.0
   * Thinwrap baseline — consumers can override
   * `_passthrough.body.messages`.
   */
  async send(input: InfobipNarrowedInput): Promise<SmsSendResult> {
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
    if (input.validityPeriod !== undefined)
      messageEntry.validityPeriod = input.validityPeriod;
    if (input.validityPeriodTimeUnit !== undefined)
      messageEntry.validityPeriodTimeUnit = input.validityPeriodTimeUnit;
    if (input.flash !== undefined) messageEntry.flash = input.flash;
    if (input.language !== undefined) messageEntry.language = input.language;
    if (input.transliteration !== undefined)
      messageEntry.transliteration = input.transliteration;

    const connectorBody: Record<string, unknown> = {
      messages: [messageEntry],
    };
    if (input.bulkId !== undefined) connectorBody.bulkId = input.bulkId;
    if (input.scheduleSettings?.sendAt !== undefined)
      connectorBody.sendingDateTime = input.scheduleSettings.sendAt;

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
    return {
      success: true,
      status: 'sent',
      providerMessageId: firstMessage?.messageId ?? null,
      raw,
    };
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
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: ISmsOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const payload: Record<string, unknown> = {
      messages: [
        {
          from: options.from ?? this.config.from,
          destinations: [{ to: options.to }],
          text: options.content,
        },
      ],
    };

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

    const data = (await response.json()) as InfobipSendResponse;
    return {
      id: data.messages[0]!.messageId,
      date: new Date().toISOString(),
    };
  }
}
