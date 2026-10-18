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
import { encodePathSegment, mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import type { WhatsAppBusinessConfig } from './whatsapp-business.config';
import type {
  WhatsAppBusinessNarrowedInput,
  WhatsAppResponse,
} from './whatsapp-business.types';

/**
 * Token-auth chat connector. Authorization is a Bearer header carrying a Meta
 * Business Manager system-user access token. The endpoint embeds a versioned Graph
 * API segment (`/v21.0...`), pinned here and overridable via
 * `config.graphApiVersion`.
 *
 * `sendMessage()` exists alongside `.send()` as the Novu-compatible surface.
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
    const url = `https://graph.facebook.com/${encodePathSegment(version, 'WhatsApp graphApiVersion')}/${encodePathSegment(this.config.phoneNumberId, 'WhatsApp phoneNumberId')}/messages`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
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
   * Meta's `error.code` is matched first, then the HTTP status; see
   * {@link mapWhatsAppCode} for the table and its sources.
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
      (typeof errorCode === 'number' ? mapWhatsAppCode(errorCode) : null) ??
      (statusCode === 401 || statusCode === 403
        ? 'auth_failed'
        : statusCode === 429
          ? 'rate_limited'
          : statusCode === 400
            ? 'invalid_request'
            : statusCode >= 500
              ? 'provider_unavailable'
              : 'unknown');

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
  // Novu-compatible `sendMessage()` surface
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
        `https://graph.facebook.com/${encodePathSegment(version, 'WhatsApp graphApiVersion')}/${encodePathSegment(this.config.phoneNumberId, 'WhatsApp phoneNumberId')}/messages`,
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

/**
 * Meta Cloud API `error.code` → `ProviderCode`, per
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes.
 * Several entries are counter-intuitive: 131047 ("More than 24 hours have
 * passed since recipient last replied") needs a template, not a new recipient;
 * 133010 ("Phone number not registered on the WhatsApp Business Platform") is
 * the BUSINESS sender number; 131008 is "The request is missing a required
 * parameter"; 131048/131056 are listed by Meta as rate limits.
 */
function mapWhatsAppCode(code: number): ProviderCode | null {
  if (code >= 200 && code <= 299) return 'auth_failed'; // permission errors
  switch (code) {
    case 0: // "We were unable to authenticate the app user"
    case 3: // capability / permission
    case 10: // "Permission is either not granted or has been removed"
    case 190: // "Your access token has expired"
    case 368: // policy restriction
    case 131005: // access denied
    case 131031: // account restricted
      return 'auth_failed';
    case 4: // app rate limit
    case 80007: // WhatsApp Business Account rate limit
    case 130429: // Cloud API throughput "Rate limit hit"
    case 131048: // spam rate limit / quality restriction
    case 131056: // "Too many messages sent from the sender phone number to the same recipient"
      return 'rate_limited';
    case 131021: // sender and recipient are the same number
    case 131026: // message undeliverable (recipient not on WhatsApp, old app, ToS)
      return 'invalid_recipient';
    case 100: // invalid parameter
    case 131008: // required parameter missing
    case 131009: // parameter value invalid
    case 131042: // business payment issue
    case 131045: // phone-number registration error
    case 131047: // re-engagement: outside the 24h window, send a template
    case 131051: // unsupported message type
    case 132000: // template param count mismatch
    case 132001: // template does not exist
    case 132012: // template param format mismatch
    case 133010: // business phone number not registered
      return 'invalid_request';
    case 1: // API unknown
    case 2: // API service
    case 131000: // "Something went wrong"
    case 131016: // "A service is temporarily unavailable."
    case 131057: // account in maintenance mode
      return 'provider_unavailable';
    default:
      return null;
  }
}
