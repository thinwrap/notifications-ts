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
import type { TextmagicConfig } from './textmagic.config';
import type {
  TextmagicNarrowedInput,
  TextmagicSendResponse,
} from './textmagic.types';

const TEXTMAGIC_ENDPOINT = 'https://rest.textmagic.com/api/v2/messages';

export class TextmagicSmsConnector
  extends BaseConnector
  implements ISmsProvider, ISmsConnector
{
  public readonly id = 'textmagic';
  public readonly channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(private config: TextmagicConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `ISmsConnector`.
   *
   * Two outliers compared with other wrapped SMS providers:
   *  1. **Two-header auth pair** — `X-TM-Username` + `X-TM-Key` are independent
   *     headers, both required. Not Basic, not Bearer.
   *  2. **Form-urlencoded body** — `application/x-www-form-urlencoded` (most
   *     modern SMS providers use JSON). All numeric narrowed-input fields are
   *     stringified explicitly; booleans encode as `'1'` / `'0'` (Textmagic's
   *     documented expectation), not `'true'` / `'false'`.
   *
   * Wire-key casing is camelCase, written explicitly (no
   * `transformKeys` invocation). The recipient field is `phones` on the wire
   * (Textmagic supports comma-separated multi-recipient on this field);
   * single-recipient v1.0 baseline maps `input.to` → `phones` verbatim.
   */
  async send(input: TextmagicNarrowedInput): Promise<SmsSendResult> {
    const from = input.from ?? this.config.from;

    const connectorBody: Record<string, string> = {
      text: input.body,
      phones: input.to,
    };
    if (from !== undefined) connectorBody.from = from;
    if (input.templateId !== undefined)
      connectorBody.templateId = String(input.templateId);
    if (input.sendingTime !== undefined)
      connectorBody.sendingTime = String(input.sendingTime);
    if (input.tz !== undefined) connectorBody.tz = input.tz;
    if (input.partsCount !== undefined)
      connectorBody.partsCount = String(input.partsCount);
    if (input.referenceId !== undefined)
      connectorBody.referenceId = String(input.referenceId);
    if (input.rrule !== undefined) connectorBody.rrule = input.rrule;
    if (input.cutExtra !== undefined)
      connectorBody.cutExtra = input.cutExtra ? '1' : '0';

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
      connectorBody,
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-TM-Username': this.config.username,
        'X-TM-Key': this.config.apiKey,
      },
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
      response = await this.fetchImpl(TEXTMAGIC_ENDPOINT, {
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
      const errBody = (await response.json().catch(() => null)) as
        | { message?: string; code?: number | string }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as TextmagicSendResponse;
    const providerMessageId =
      raw.id !== undefined
        ? String(raw.id)
        : raw.messageId !== undefined
          ? String(raw.messageId)
          : null;

    return {
      success: true,
      status: 'sent',
      providerMessageId,
      raw,
    };
  }

  /**
   * Map Textmagic error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header value on
   * `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    statusCode: number,
    body: { message?: string; code?: number | string } | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const message = body?.message;
    const code = body?.code;

    const providerCode: ProviderCode =
      statusCode === 401 || statusCode === 403
        ? 'auth_failed'
        : statusCode === 429
          ? 'rate_limited'
          : statusCode === 422
            ? 'invalid_recipient'
            : statusCode >= 500
              ? 'provider_unavailable'
              : statusCode >= 400
                ? 'invalid_request'
                : 'unknown';

    const baseMessage =
      message ?? `Textmagic HTTP ${statusCode}${code !== undefined ? ` ${code}` : ''}`;

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
    const from = options.from ?? this.config.from;

    const payload: Record<string, unknown> = {
      text: options.content,
      phones: options.to,
      ...(from ? { from } : {}),
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(TEXTMAGIC_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TM-Username': this.config.username,
          'X-TM-Key': this.config.apiKey,
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
        | { message?: string; code?: number | string }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as TextmagicSendResponse;
    return {
      id: String(data.messageId),
      date: new Date().toISOString(),
    };
  }
}
