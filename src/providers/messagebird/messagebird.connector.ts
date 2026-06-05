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
import type { MessageBirdConfig } from './messagebird.config';
import type {
  MessageBirdNarrowedInput,
  MessageBirdSendResponse,
} from './messagebird.types';

const MESSAGEBIRD_ENDPOINT = 'https://rest.messagebird.com/messages';

export class MessageBirdSmsConnector
  extends BaseConnector
  implements ISmsProvider, ISmsConnector
{
  public readonly id = 'messagebird';
  public readonly channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(private config: MessageBirdConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `ISmsConnector`.
   * Builds a JSON body in mixed-case (explicit casing — most keys are
   * camelCase, but `datacoding` and `mclass` are lowercased-flat on the wire)
   * and POSTs to `https://rest.messagebird.com/messages`.
   *
   * MessageBird's API requires `recipients: string[]` even for single-recipient
   * sends; the connector wraps `[input.to]` automatically. Multi-recipient
   * batches are out of v1.0 Thinwrap baseline — consumers can
   * override via `_passthrough.body.recipients`.
   *
   * Auth uses the custom `Authorization: AccessKey <accessKey>` scheme (same
   * family as Infobip's `App <key>` — neither Bearer nor Basic).
   */
  async send(input: MessageBirdNarrowedInput): Promise<SmsSendResult> {
    const originator = input.from ?? this.config.from;
    if (!originator) {
      throw new ConnectorError({
        message:
          'MessageBird requires `from` (originator) in either input.from or config.from.',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'MessageBird requires `from` (originator) in either input.from or config.from.',
      });
    }

    const connectorBody: Record<string, unknown> = {
      originator,
      recipients: [input.to],
      body: input.body,
    };
    if (input.type !== undefined) connectorBody.type = input.type;
    if (input.reference !== undefined) connectorBody.reference = input.reference;
    if (input.validity !== undefined) connectorBody.validity = input.validity;
    if (input.gateway !== undefined) connectorBody.gateway = input.gateway;
    if (input.typeDetails !== undefined)
      connectorBody.typeDetails = input.typeDetails;
    // outlier mapping: camelCase narrowed key → lowercased-flat wire key.
    if (input.dataCoding !== undefined)
      connectorBody.datacoding = input.dataCoding;
    if (input.mclass !== undefined) connectorBody.mclass = input.mclass;
    if (input.scheduledDatetime !== undefined)
      connectorBody.scheduledDatetime = input.scheduledDatetime;

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        {
          'Content-Type': 'application/json',
          Authorization: `AccessKey ${this.config.accessKey}`,
        },
        input._passthrough,
      );

    const url =
      Object.keys(mergedQuery).length > 0
        ? `${MESSAGEBIRD_ENDPOINT}?${new URLSearchParams(mergedQuery).toString()}`
        : MESSAGEBIRD_ENDPOINT;

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
            errors?: Array<{
              code?: number;
              description?: string;
              parameter?: string;
            }>;
          }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as MessageBirdSendResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.id ?? null,
      raw,
    };
  }

  /**
   * Map MessageBird error responses to canonical `ConnectorError` with the
   * 6-value `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header
   * value on `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   *
   * MessageBird's body error structure is
   * `{ errors: [{ code, description, parameter }] }`; numeric `code` is
   * preserved in `cause.raw` but not mapped to canonical providerCodes (HTTP
   * status drives canonical mapping).
   */
  private mapVendorError(
    statusCode: number,
    body: {
      errors?: Array<{
        code?: number;
        description?: string;
        parameter?: string;
      }>;
    } | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const firstError = body?.errors?.[0];

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

    const baseMessage =
      firstError?.description ?? `MessageBird HTTP ${statusCode}`;

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
      originator: options.from ?? this.config.from,
      body: options.content,
      recipients: [options.to],
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(MESSAGEBIRD_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `AccessKey ${this.config.accessKey}`,
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
        | {
            errors?: Array<{
              code?: number;
              description?: string;
              parameter?: string;
            }>;
          }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as MessageBirdSendResponse;
    return {
      id: data.id,
      date: new Date().toISOString(),
    };
  }
}
