import { BaseConnector } from '../../base/base.connector';
import { CasingEnum, transformKeys } from '../../base/casing-transform';
import type {
  EmailSendInput,
  EmailSendResult,
  IEmailConnector,
} from '../../types';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import { encodeBase64Ascii, encodeBase64Bytes } from '../../utils';
import type { ScalewayConfig, ScalewayRegion } from './scaleway.config';
import type {
  ScalewaySendEmailResponse,
  ScalewayErrorResponse,
} from './scaleway.types';

const SCALEWAY_API_BASE =
  'https://api.scaleway.com/transactional-email/v1alpha1';
const DEFAULT_REGION: ScalewayRegion = 'fr-par';
const DEFAULT_ATTACHMENT_MIME = 'application/octet-stream';

/** One `{ email, name? }` address object in Scaleway's wire body. */
interface ScalewayAddress {
  email: string;
  name?: string;
}

export class ScalewayEmailConnector
  extends BaseConnector
  implements IEmailConnector
{
  public readonly id = 'scaleway';
  public readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;

  constructor(private config: ScalewayConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IEmailConnector`.
   * Builds Scaleway TEM's snake_case JSON body (nested `from`/`to` address
   * objects + mandatory `project_id`) and POSTs to the region-scoped path
   * `…/regions/{region}/emails` with `X-Auth-Token` auth.
   *
   * Scaleway is structurally close to SparkPost (region + nested address
   * objects + snake_case wire) but differs in three ways handled here:
   *   1. **Region is part of the URL path**, not a host swap (see
   *      `resolveEndpoint()`).
   *   2. **Auth is `X-Auth-Token: <secretKey>`** — not `Authorization`.
   *   3. **`project_id` is mandatory** and comes from config.
   *
   * Unlike SparkPost there is NO Novu brownfield `sendMessage` surface — Novu
   * has no Scaleway provider, so this connector is Thinwrap-native only per
   * Novu compat is best-effort, not a contract.
   *
   * Graceful degradation the >=90% baseline-coverage rule:
   *   - `tags` — Scaleway has no tags field at v1.0; silently dropped.
   *   - attachment `contentId` — no inline-image field at v1.0; silently dropped.
   *   - `replyTo` — Scaleway has no `reply_to` field; emitted as a
   *     `Reply-To` entry in `additional_headers`.
   */
  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const url = this.resolveEndpoint();
    const connectorBody = this.buildScalewayBody(input);

    // explicit per-connector casing-transform on the consumer's
    // `_passthrough.body`. Scaleway's wire shape is snake_case, so consumer
    // camelCase keys (`scheduledAt`) become snake_case (`scheduled_at`). Only
    // keys are rewritten; values pass verbatim.
    const normalizedPassthroughBody =
      input._passthrough?.body !== undefined
        ? (transformKeys(
            input._passthrough.body as Record<string, unknown>,
            CasingEnum.SNAKE_CASE,
          ) as Record<string, unknown>)
        : undefined;
    const normalizedPassthrough =
      input._passthrough && normalizedPassthroughBody !== undefined
        ? { ...input._passthrough, body: normalizedPassthroughBody }
        : input._passthrough;

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Auth-Token': this.config.secretKey,
        },
        normalizedPassthrough,
      );

    const queryString = buildQueryString(mergedQuery);
    const fullUrl = `${url}${queryString}`;
    const serializedBody = JSON.stringify(mergedBody);

    let response: Response;
    try {
      response = await this.fetchImpl(fullUrl, {
        method: 'POST',
        headers: mergedHeaders,
        body: serializedBody,
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
        | ScalewayErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json().catch(() => null)) as
      | ScalewaySendEmailResponse
      | null;

    // Scaleway accepts-for-delivery asynchronously; a fresh email reports
    // `status: "new"` ("not yet processed"). Async accept → 'queued'
    // (vendor-faithful). A 2xx with an empty/missing `emails` array is
    // still a success — we do not synthesize an error.
    const first = raw?.emails?.[0];
    const providerMessageId = first?.message_id ?? first?.id ?? null;

    return {
      success: true,
      status: 'queued',
      providerMessageId,
      raw: raw ?? {},
    };
  }

  /**
   * Resolve the region-scoped Scaleway endpoint. The region (default `fr-par`)
   * is interpolated into the PATH — Scaleway uses one host for every region.
   */
  private resolveEndpoint(): string {
    const region = this.config.region ?? DEFAULT_REGION;
    return `${SCALEWAY_API_BASE}/regions/${region}/emails`;
  }

  /**
   * Hand-build Scaleway's snake_case wire body from Thinwrap's `EmailSendInput`.
   * (locality) the structural wire translation is local to
   * this connector — `additional_headers` Record→array adapter and the nested
   * address-object shaping live here, not in shared middleware.
   */
  private buildScalewayBody(input: EmailSendInput): Record<string, unknown> {
    const fromAddress = input.from || this.config.from;
    const from: ScalewayAddress = { email: fromAddress };
    if (this.config.senderName) from.name = this.config.senderName;

    const body: Record<string, unknown> = {
      from,
      to: toAddressArray(input.to),
      subject: input.subject,
      project_id: this.config.projectId,
    };

    if (input.cc && input.cc.length > 0) body.cc = toAddressArray(input.cc);
    if (input.bcc && input.bcc.length > 0) body.bcc = toAddressArray(input.bcc);
    if (input.text) body.text = input.text;
    if (input.html) body.html = input.html;

    // `additional_headers`: Record<string,string> → Array<{key,value}>.
    // `replyTo` has no first-class Scaleway field — fold it in as `Reply-To`.
    const headerPairs: Array<{ key: string; value: string }> = [];
    if (input.replyTo) {
      headerPairs.push({ key: 'Reply-To', value: input.replyTo });
    }
    if (input.headers) {
      for (const [key, value] of Object.entries(input.headers)) {
        headerPairs.push({ key, value });
      }
    }
    if (headerPairs.length > 0) body.additional_headers = headerPairs;

    if (input.attachments && input.attachments.length > 0) {
      body.attachments = input.attachments.map((a) => {
        const contentBase64 =
          typeof a.content === 'string'
            ? encodeBase64Ascii(a.content)
            : encodeBase64Bytes(a.content);
        // Scaleway requires a non-empty `type` (mime) on every attachment.
        // `||` (not `??`) so an empty-string contentType also falls back —
        // matches the PHP connector and avoids emitting `type: ""`.
        return {
          name: a.filename,
          type: a.contentType || DEFAULT_ATTACHMENT_MIME,
          content: contentBase64,
        };
        // NB: `contentId` (inline images) has no Scaleway field at v1.0 —
        // silently dropped the >=90% baseline-coverage rule.
      });
    }

    // NB: `tags` has no Scaleway field at v1.0 — silently dropped.

    return body;
  }

  /**
   * Map Scaleway error responses to canonical `ConnectorError` with the 6-value
   * `ProviderCode` union. Parses `Retry-After`:
   * parsed seconds embedded in `providerMessage` text; raw header
   * value on `cause.retryAfter`. No top-level `retryAfterSeconds` field per
   * Retry is consumer policy (no retryAfterSeconds field).
   */
  private mapVendorError(
    status: number,
    body: ScalewayErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const errorMessage =
      body?.message ?? body?.errors?.[0]?.message ?? '<no vendor message>';

    const providerCode = mapScalewayErrorToProviderCode(status);

    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds =
      retryAfterHeader != null ? parseRetryAfter(retryAfterHeader) : null;

    const cause: Record<string, unknown> = { raw: body ?? null };
    if (retryAfterHeader != null) cause.retryAfter = retryAfterHeader;
    if (retryAfterSeconds != null) cause.retryAfterSeconds = retryAfterSeconds;

    const providerMessage =
      retryAfterSeconds != null
        ? `${errorMessage} (Retry-After: ${retryAfterSeconds} seconds)`
        : errorMessage;

    return new ConnectorError({
      message: errorMessage,
      statusCode: status,
      providerCode,
      providerMessage,
      cause,
    });
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** Normalize a `string | string[]` recipient field to Scaleway `{email}[]`. */
function toAddressArray(value: string | string[]): ScalewayAddress[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((email) => ({ email }));
}

function buildQueryString(query: Record<string, string>): string {
  const keys = Object.keys(query);
  if (keys.length === 0) return '';
  return '?' + new URLSearchParams(query).toString();
}

/**
 * Map a Scaleway HTTP status to a canonical `ProviderCode`. Scaleway does not
 * use a body-level error-code disambiguator the way Postmark does, so HTTP
 * status is the sole signal.
 */
function mapScalewayErrorToProviderCode(status: number): ProviderCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  // 400 (validation), 404 (bad region/project route), 422 (if returned).
  if (status === 400 || status === 404 || status === 422) {
    return 'invalid_request';
  }
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}
