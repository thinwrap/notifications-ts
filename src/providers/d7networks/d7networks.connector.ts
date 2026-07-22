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
import type { D7NetworksConfig } from './d7networks.config';
import type {
  D7NetworksNarrowedInput,
  D7NetworksSendResponse,
} from './d7networks.types';

const D7_ENDPOINT = 'https://api.d7networks.com/messages/v1/send';

export class D7NetworksSmsConnector
  extends BaseConnector
  implements ISmsProvider, ISmsConnector
{
  public readonly id = 'd7networks';
  public readonly channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(private config: D7NetworksConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `ISmsConnector`.
   * POSTs JSON to `https://api.d7networks.com/messages/v1/send` with Bearer
   * auth.
   *
   * D7's wire shape is the most nested of any SMS provider (outlier):
   * per-message fields live inside `messages[]`, global fields live inside
   * `message_globals`. The connector silently allocates each narrowed-input
   * field to the correct nesting level. Snake-case wire keys (`msg_type`,
   * `data_coding`, `schedule_time`, `validity_period`, `report_url`,
   * `message_globals`) are written explicitly — no `transformKeys`
   * invocation.
   *
   * `originator` precedence: `input.originator` (preferred, matches D7's
   * vocabulary) → `input.from` (matches Thinwrap baseline) → `config.from`.
   */
  async send(input: D7NetworksNarrowedInput): Promise<SmsSendResult> {
    const originator = input.originator ?? input.from ?? this.config.from;
    if (!originator) {
      throw new ConnectorError({
        message:
          'D7 Networks requires `originator` or `from` in input, or `config.from`.',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'D7 Networks requires `originator` or `from` in input, or `config.from`.',
      });
    }

    const messageEntry: Record<string, unknown> = {
      channel: 'sms',
      recipients: [input.to],
      content: input.body,
      msg_type: input.msgType ?? 'text',
    };
    if (input.dataCoding !== undefined) {
      messageEntry.data_coding = input.dataCoding;
    }

    const messageGlobals: Record<string, unknown> = { originator };
    if (input.tag !== undefined) messageGlobals.tag = input.tag;
    if (input.scheduleTime !== undefined)
      messageGlobals.schedule_time = input.scheduleTime;
    if (input.validityPeriod !== undefined)
      messageGlobals.validity_period = input.validityPeriod;
    if (input.reportUrl !== undefined)
      messageGlobals.report_url = input.reportUrl;

    const connectorBody: Record<string, unknown> = {
      messages: [messageEntry],
      message_globals: messageGlobals,
    };

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
      connectorBody,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiToken}`,
        Accept: 'application/json',
      },
      input._passthrough,
    );

    const url = D7_ENDPOINT;

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
        | { detail?: string; code?: string }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as D7NetworksSendResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.request_id ?? null,
      raw,
    };
  }

  /**
   * Map D7 error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. D7's body error structure is
   * `{ code: string, detail: string }`; both fields preserved in error message
   * and `cause.raw`. Parses `Retry-After`: parsed seconds
   * embedded in `providerMessage` text; raw header value on `cause.retryAfter`.
   * No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    statusCode: number,
    body: { detail?: string; code?: string } | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const detail = body?.detail;
    const code = body?.code;

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
      detail ?? `D7 Networks HTTP ${statusCode} ${code ?? ''}`.trim();

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
          channel: 'sms',
          recipients: [options.to],
          content: options.content,
          msg_type: 'text',
        },
      ],
      message_globals: {
        originator: options.from ?? this.config.from,
      },
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(D7_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiToken}`,
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
        | { detail?: string; code?: string }
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as D7NetworksSendResponse;
    return {
      id: data.request_id,
      date: new Date().toISOString(),
    };
  }
}
