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
import type { WhatsAppBusinessConfig } from './whatsapp-business.config';
import type {
  WhatsAppBusinessNarrowedInput,
  WhatsAppResponse,
} from './whatsapp-business.types';

/**
 * Token-auth chat connector. Authorization is a Bearer header
 * carrying a Meta Business Manager system-user access token. The endpoint
 * embeds a versioned Graph API segment (`/v21.0...`) pinned outlier
 * discipline and overridable via `config.graphApiVersion`.
 *
 * Brownfield `sendMessage()` is preserved verbatim alongside the new `.send()`
 * for's Novu provider-interface wrap.
 */
const DEFAULT_GRAPH_API_VERSION = 'v21.0';

export class WhatsAppChatConnector
  extends BaseConnector
  implements IChatProvider, IChatConnector
{
  public readonly id = 'whatsapp-business' as const;
  public readonly channelType = ChannelTypeEnum.CHAT as ChannelTypeEnum.CHAT;

  constructor(
    private config: WhatsAppBusinessConfig,
    fetchImpl?: typeof fetch,
  ) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IChatConnector`.
   *
   * Builds a JSON body for Meta's `POST /v<X>/<phoneNumberId>/messages`
   * endpoint. Snake_case wire keys (`messaging_product`, `recipient_type`,
   * `message_id`, `preview_url`) are written explicitly —
   * no `Casing` helper is invoked on this code path.
   *
   * Body-vs-template/interactive contract: when `type === 'template'` or
   * `type === 'interactive'`, `input.body` is **ignored** (the wire payload is
   * built from `input.template` / `input.interactive` respectively, per Meta's
   * documented Cloud API shapes).
   */
  async send(input: WhatsAppBusinessNarrowedInput): Promise<ChatSendResult> {
    if (!input.to) {
      throw new ConnectorError({
        message: 'WhatsApp Business requires `to`',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'WhatsApp Business requires `to` (E.164 phone number).',
        cause: null,
      });
    }

    const type = input.type ?? 'text';
    const connectorBody: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.to,
      type,
    };

    if (type === 'text') {
      const textShape: Record<string, unknown> = { body: input.body };
      if (input.previewUrl !== undefined) {
        textShape.preview_url = input.previewUrl;
      }
      connectorBody.text = textShape;
    } else if (type === 'template' && input.template) {
      // `input.body` intentionally ignored — templates carry content via
      // component parameters.
      connectorBody.template = input.template;
    } else if (type === 'interactive' && input.interactive) {
      // `input.body` intentionally ignored — interactive messages carry
      // content via `interactive.body.text`.
      connectorBody.interactive = input.interactive;
    }
    // For other types (image / document / video / audio / location /
    // contacts), the consumer is expected to supply the matching shape via
    // `_passthrough.body.*`. We do NOT synthesize media-upload shapes in v1.0.

    if (input.context) {
      connectorBody.context = { message_id: input.context.messageId };
    }

    const { body: mergedBody, headers: mergedHeaders } = mergePassthrough<
      Record<string, unknown>
    >(
      connectorBody,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.accessToken}`,
      },
      input._passthrough,
    );

    const version = this.config.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
    const url = `https://graph.facebook.com/${version}/${this.config.phoneNumberId}/messages`;

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
        | WhatsAppResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as WhatsAppResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.messages?.[0]?.id ?? null,
      raw,
    };
  }

  /**
   * HTTP-layer Meta error-code mapping. ConnectorError
   * carries no `retryAfterSeconds` field — retry is consumer policy:
   * parsed seconds embedded in `providerMessage` text, raw header preserved on
   * `cause.retryAfter`. Wrapper performs no retry.
   *
   * Meta error-code reference (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes):
   *   190             → auth_failed         (access token invalid/expired)
   *   131008          → invalid_recipient   (recipient not in allowed list)
   *   131026 / 131047 → invalid_recipient   (24h window expired / re-engagement)
   *   131051 / 131056 → invalid_request     (unsupported message type / pair-rate)
   *   80007 / 4 / 80004 → rate_limited     (business / app / throttle quotas)
   *   1 / 2           → provider_unavailable (temporary Graph API failure)
   */
  private mapVendorError(
    statusCode: number,
    body: WhatsAppResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const errorObj = body?.error;
    const errorCode = errorObj?.code;
    const message = errorObj?.message;

    const providerCode: ProviderCode =
      errorCode === 190
        ? 'auth_failed'
        : statusCode === 401
          ? 'auth_failed'
          : errorCode === 131008 ||
              errorCode === 131026 ||
              errorCode === 131047
            ? 'invalid_recipient'
            : errorCode === 80007 || errorCode === 80004 || errorCode === 4
              ? 'rate_limited'
              : statusCode === 429
                ? 'rate_limited'
                : errorCode === 131051 || errorCode === 131056
                  ? 'invalid_request'
                  : statusCode === 400
                    ? 'invalid_request'
                    : errorCode === 1 || errorCode === 2
                      ? 'provider_unavailable'
                      : statusCode >= 500
                        ? 'provider_unavailable'
                        : 'unknown';

    const baseMessage = message ?? `WhatsApp HTTP ${statusCode}`;

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
      messaging_product: 'whatsapp',
      to: options.channel,
      type: 'text',
      text: { body: options.content },
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const version = this.config.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://graph.facebook.com/${version}/${this.config.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.accessToken}`,
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
        | WhatsAppResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as WhatsAppResponse;
    return {
      id: data.messages![0]!.id,
      date: new Date().toISOString(),
    };
  }
}
