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
import { encodeBase64Ascii } from '../../utils';
import type { PlivoConfig } from './plivo.config';
import type {
  PlivoNarrowedInput,
  PlivoMessageResponse,
  PlivoErrorResponse,
} from './plivo.types';

export class PlivoSmsConnector
  extends BaseConnector
  implements ISmsProvider, ISmsConnector
{
  public readonly id = 'plivo';
  public readonly channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(private config: PlivoConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `ISmsConnector`.
   * Builds a JSON request body in snake_case wire shape (Plivo is one of the
   * few SMS providers that accepts JSON instead of form-encoded),
   * authenticates with HTTP Basic (`authId:authToken`), and POSTs to
   * `https://api.plivo.com/v1/Account/<authId>/Message/` — the trailing slash
   * is required by Plivo.
   *
   * the connector writes wire keys (`src`, `dst`, `text`, `dlt_*`,
   * `powerpack_uuid`, `template_id`) explicitly in the `connectorBody` literal
   * — no shared casing transform is invoked since the connector-built fields
   * are already snake_case.
   *
   * `message_uuid` is documented as `string[]`; Thinwrap reports
   * `providerMessageId = raw.message_uuid?.[0] ?? null` Dev
   * Notes — consumers needing all segment UUIDs read `result.raw.message_uuid`.
   */
  async send(input: PlivoNarrowedInput): Promise<SmsSendResult> {
    const src = input.from ?? this.config.from;
    if (!src && !input.powerpackUuid) {
      throw new ConnectorError({
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Plivo requires `from`, `config.from`, or `powerpackUuid`.',
      });
    }

    const connectorBody: Record<string, unknown> = {
      dst: input.to,
      text: input.body,
    };
    if (src) connectorBody.src = src;
    if (input.powerpackUuid) connectorBody.powerpack_uuid = input.powerpackUuid;
    if (input.url) connectorBody.url = input.url;
    if (input.method) connectorBody.method = input.method;
    if (input.log !== undefined) connectorBody.log = input.log;
    if (input.trackable !== undefined) connectorBody.trackable = input.trackable;
    if (input.dltEntityId) connectorBody.dlt_entity_id = input.dltEntityId;
    if (input.dltTemplateId) connectorBody.dlt_template_id = input.dltTemplateId;
    if (input.dltTemplateCategory)
      connectorBody.dlt_template_category = input.dltTemplateCategory;
    if (input.templateId) connectorBody.template_id = input.templateId;

    const authHeader =
      'Basic ' +
      encodeBase64Ascii(`${this.config.authId}:${this.config.authToken}`);

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        input._passthrough,
      );

    const url = `https://api.plivo.com/v1/Account/${this.config.authId}/Message/`;

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
        | PlivoErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as PlivoMessageResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.message_uuid?.[0] ?? null,
      raw,
    };
  }

  /**
   * Map Plivo error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header
   * value on `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   *
   * Plivo's error body shape is `{ api_id, error }` — both preserved in
   * `cause.raw`. `api_id` is an opaque request UUID, not an error code, so it
   * never sets `providerCode`.
   */
  private mapVendorError(
    statusCode: number,
    body: PlivoErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    // both 401 and 403 → auth_failed.
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

    const baseMessage = body?.error ?? `Plivo HTTP ${statusCode}`;

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
    const payload = {
      src: options.from ?? this.config.from,
      dst: options.to,
      text: options.content,
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const auth = encodeBase64Ascii(
      `${this.config.authId}:${this.config.authToken}`,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.plivo.com/v1/Account/${this.config.authId}/Message/`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`,
            ...passthroughHeaders,
          },
          body: JSON.stringify(body),
        }
      );
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
        | PlivoErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as PlivoMessageResponse;
    return {
      id: data.message_uuid[0]!,
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

