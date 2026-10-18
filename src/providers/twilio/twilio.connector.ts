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
import { encodePathSegment, mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import { encodeBase64Ascii } from '../../utils';
import type { TwilioConfig } from './twilio.config';
import type {
  TwilioNarrowedInput,
  TwilioMessageResponse,
  TwilioRegion,
  TwilioEdge,
  TwilioErrorResponse,
} from './twilio.types';

/**
 * Default edge per non-US processing region. Twilio: "The edge location name
 * (dublin, sydney) is a required part of the hostname for non-US regions", and
 * the legacy-regions table pairs ie1 with dublin and au1 with sydney. No Twilio
 * SDK ships such a map (they require the caller to pass both), so this is the
 * library's documented default.
 */
export const TWILIO_DEFAULT_EDGES: Readonly<Record<Exclude<TwilioRegion, 'us1'>, TwilioEdge>> = {
  ie1: 'dublin',
  au1: 'sydney',
};

const TWILIO_REGIONS: ReadonlySet<string> = new Set<TwilioRegion>(['us1', 'ie1', 'au1']);

const TWILIO_EDGES: ReadonlySet<string> = new Set<TwilioEdge>([
  'sydney',
  'sao-paulo',
  'dublin',
  'frankfurt',
  'tokyo',
  'singapore',
  'ashburn',
  'umatilla',
  'roaming',
]);

// Legacy ids whose `api.<id>.twilio.com` host went dark on 2026-04-28; Twilio
// says they "process in US1 — use api.twilio.com".
const TWILIO_US1_ONLY_LEGACY_IDS: ReadonlySet<string> = new Set(['us2', 'br1', 'de1', 'jp1', 'sg1']);

/**
 * Resolve the Messages API host for a region/edge pair, following Twilio's
 * documented `PRODUCT.EDGE.REGION.twilio.com` shape. Both values are
 * interpolated into the hostname the Basic credentials are sent to, so each
 * must come from the closed lists above; anything else is rejected before a
 * request is built.
 */
export function twilioApiHost(region: string | undefined, edge: string | undefined): string {
  const resolvedRegion = region ?? 'us1';
  if (!TWILIO_REGIONS.has(resolvedRegion)) {
    const hint = TWILIO_US1_ONLY_LEGACY_IDS.has(resolvedRegion)
      ? ` Twilio processes "${resolvedRegion}" traffic in us1; omit \`region\` (or pass \`edge\` to choose an edge).`
      : '';
    throw invalidTwilioConfig(
      `Unknown Twilio region "${resolvedRegion}". Supported: us1, ie1, au1.${hint}`,
    );
  }
  if (edge !== undefined && !TWILIO_EDGES.has(edge)) {
    throw invalidTwilioConfig(
      `Unknown Twilio edge "${edge}". Supported: ${[...TWILIO_EDGES].join(', ')}.`,
    );
  }
  if (resolvedRegion === 'us1') {
    // `api.twilio.com` is Twilio's canonical us1 host; an explicit edge needs
    // the fully-qualified form.
    return edge === undefined ? 'api.twilio.com' : `api.${edge}.us1.twilio.com`;
  }
  const resolvedEdge = edge ?? TWILIO_DEFAULT_EDGES[resolvedRegion as Exclude<TwilioRegion, 'us1'>];
  return `api.${resolvedEdge}.${resolvedRegion}.twilio.com`;
}

function invalidTwilioConfig(message: string): ConnectorError {
  return new ConnectorError({
    message,
    statusCode: null,
    providerCode: 'invalid_request',
    providerMessage: message,
  });
}

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
   * to the Twilio Messages endpoint for `config.region` / `config.edge`
   * (see {@link twilioApiHost}).
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
    const url = this.messagesUrl();
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
            { deep: false },
          ) as Record<string, unknown>)
        : undefined;
    const normalizedPassthrough =
      input._passthrough && normalizedPassthroughBody !== undefined
        ? { ...input._passthrough, body: normalizedPassthroughBody }
        : input._passthrough;

    const authHeader =
      'Basic ' +
      encodeBase64Ascii(`${this.config.accountSid}:${this.config.authToken}`);

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody as unknown as Record<string, unknown>,
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: authHeader,
        },
        normalizedPassthrough,
      );

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

  private messagesUrl(): string {
    const host = twilioApiHost(this.config.region, this.config.edge);
    return `https://${host}/2010-04-01/Accounts/${encodePathSegment(this.config.accountSid, 'Twilio accountSid')}/Messages.json`;
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
  // Novu-compatible `sendMessage()` surface
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: ISmsOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const url = this.messagesUrl();
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
      url,
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
