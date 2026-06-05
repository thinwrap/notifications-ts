import { BaseConnector } from '../../base/base.connector';
import { CasingEnum, transformKeys } from '../../base/casing-transform';
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
import type { TwilioConfig } from './twilio.config';
import type {
  TwilioNarrowedInput,
  TwilioMessageResponse,
  TwilioRegion,
  TwilioErrorResponse,
} from './twilio.types';

/**
 * Regional-cluster host map. us1 is the canonical/default cluster and does
 * NOT have a regional subdomain (`api.twilio.com`, not `api.us1.twilio.com`);
 * every other region uses the `api.<region>.twilio.com` pattern. A static
 * `Record` is used instead of a template-string concatenation so the us1
 * default case is encoded explicitly. Adding a new region (e.g., `kr1`) is a
 * one-line addition to this map + one entry in the `TwilioRegion` union.
 */
export const TWILIO_BASE_HOSTS: Record<TwilioRegion, string> = {
  us1: 'api.twilio.com',
  us2: 'api.us2.twilio.com',
  ie1: 'api.ie1.twilio.com',
  au1: 'api.au1.twilio.com',
  br1: 'api.br1.twilio.com',
  de1: 'api.de1.twilio.com',
  jp1: 'api.jp1.twilio.com',
  sg1: 'api.sg1.twilio.com',
};

export class TwilioSmsConnector
  extends BaseConnector
  implements ISmsProvider, ISmsConnector
{
  public readonly id = 'twilio';
  public readonly channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(private config: TwilioConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `ISmsConnector`.
   * Builds an `application/x-www-form-urlencoded` body in PascalCase wire
   * shape, authenticates with HTTP Basic (`accountSid:authToken`), and POSTs
   * to the regional Twilio Messages endpoint. the URL is constructed
   * via `TWILIO_BASE_HOSTS[config.region ?? 'us1']`.
   *
   * the connector explicitly invokes
   * `transformKeys(_passthrough.body, CasingEnum.PASCAL_CASE)` so consumer-
   * supplied camelCase keys (e.g., `messagingServiceSid`) land as PascalCase
   * (`MessagingServiceSid`) in the form body alongside the connector-built
   * fields.
   *
   * `mediaUrl` (string[]) is encoded as multiple `MediaUrl=` form fields per
   * Twilio's documented multi-attachment shape — never comma-joined.
   */
  async send(input: TwilioNarrowedInput): Promise<SmsSendResult> {
    const from = input.from ?? this.config.from;
    if (!from && !input.messagingServiceSid) {
      throw new ConnectorError({
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Twilio requires either `from`, `config.from`, or `messagingServiceSid`.',
      });
    }

    const connectorBody: Record<string, string | string[]> = {
      To: input.to,
      Body: input.body,
    };
    if (from) connectorBody.From = from;
    if (input.messagingServiceSid)
      connectorBody.MessagingServiceSid = input.messagingServiceSid;
    if (input.mediaUrl) connectorBody.MediaUrl = input.mediaUrl;
    if (input.statusCallback) connectorBody.StatusCallback = input.statusCallback;
    if (input.applicationSid) connectorBody.ApplicationSid = input.applicationSid;
    if (input.maxPrice) connectorBody.MaxPrice = input.maxPrice;
    if (input.provideFeedback !== undefined)
      connectorBody.ProvideFeedback = String(input.provideFeedback);
    if (input.validityPeriod !== undefined)
      connectorBody.ValidityPeriod = String(input.validityPeriod);
    if (input.forceDelivery !== undefined)
      connectorBody.ForceDelivery = String(input.forceDelivery);
    if (input.contentRetention)
      connectorBody.ContentRetention = input.contentRetention;
    if (input.addressRetention)
      connectorBody.AddressRetention = input.addressRetention;
    if (input.smartEncoded !== undefined)
      connectorBody.SmartEncoded = String(input.smartEncoded);
    if (input.persistentAction) connectorBody.PersistentAction = input.persistentAction;
    if (input.shortenUrls !== undefined)
      connectorBody.ShortenUrls = String(input.shortenUrls);
    if (input.scheduleType) connectorBody.ScheduleType = input.scheduleType;
    if (input.sendAt) connectorBody.SendAt = input.sendAt;
    if (input.sendAsMms !== undefined)
      connectorBody.SendAsMms = String(input.sendAsMms);
    if (input.contentVariables)
      connectorBody.ContentVariables = input.contentVariables;
    if (input.riskCheck) connectorBody.RiskCheck = input.riskCheck;
    if (input.contentSid) connectorBody.ContentSid = input.contentSid;

    // explicit per-connector casing-transform invocation on consumer's
    // `_passthrough.body`. Only keys are rewritten; values are passed verbatim
    // by the underlying utility.
    const normalizedPassthroughBody =
      input._passthrough?.body !== undefined
        ? (transformKeys(
            input._passthrough.body as Record<string, unknown>,
            CasingEnum.PASCAL_CASE,
          ) as Record<string, unknown>)
        : undefined;
    const normalizedPassthrough =
      input._passthrough && normalizedPassthroughBody !== undefined
        ? { ...input._passthrough, body: normalizedPassthroughBody }
        : input._passthrough;

    const authHeader =
      'Basic ' +
      encodeBase64Ascii(`${this.config.accountSid}:${this.config.authToken}`);

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody as unknown as Record<string, unknown>,
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: authHeader,
        },
        normalizedPassthrough,
      );

    const host = TWILIO_BASE_HOSTS[this.config.region ?? 'us1'];
    const queryString = buildQueryString(mergedQuery);
    const url = `https://${host}/2010-04-01/Accounts/${this.config.accountSid}/Messages.json${queryString}`;

    const response = await this.sendPostForm(url, mergedBody, {
      headers: mergedHeaders,
    });

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | TwilioErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as TwilioMessageResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.sid ?? null,
      raw,
    };
  }

  /**
   * Map Twilio error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header
   * value on `cause.retryAfter`. No structured `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    status: number,
    body: TwilioErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const errorMessage = body?.message ?? `Twilio HTTP ${status}`;
    const providerCode = mapTwilioErrorToProviderCode(status, body?.code);

    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const cause: Record<string, unknown> = { raw: body ?? null };
    if (retryAfterHeader != null) cause.retryAfter = retryAfterHeader;
    if (retryAfterSeconds != null) cause.retryAfterSeconds = retryAfterSeconds;

    return new ConnectorError({
      message: errorMessage,
      statusCode: status,
      providerCode,
      providerMessage: errorMessage,
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
      To: options.to,
      From: options.from ?? this.config.from,
      Body: options.content,
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    const auth = encodeBase64Ascii(
      `${this.config.accountSid}:${this.config.authToken}`,
    );

    const response = await this.sendPostForm(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`,
      body,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          ...passthroughHeaders,
        },
      },
    );

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | TwilioErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as TwilioMessageResponse;
    return {
      id: data.sid,
      date: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function buildQueryString(query: Record<string, string>): string {
  const keys = Object.keys(query);
  if (keys.length === 0) return '';
  return '?' + new URLSearchParams(query).toString();
}

/**
 * Map Twilio (HTTP status, vendor `code`) to canonical `ProviderCode` per
 * . HTTP-layer mapping is consulted first; body-layer Twilio
 * `code` field disambiguates 4xx into invalid_recipient/auth_failed where
 * applicable.
 */
function mapTwilioErrorToProviderCode(
  status: number,
  twilioCode: number | undefined,
): ProviderCode {
  // both 401 and 403 → auth_failed.
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';

  if (status === 400 && twilioCode !== undefined) {
    if (
      twilioCode === 21211 ||
      twilioCode === 21408 ||
      twilioCode === 21610 ||
      twilioCode === 21612 ||
      twilioCode === 21614
    ) {
      return 'invalid_recipient';
    }
    if (twilioCode === 20003) return 'auth_failed';
  }

  if (status >= 400) return 'invalid_request';
  return 'unknown';
}
