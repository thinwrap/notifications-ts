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
import { assertHttpsWebhookUrl, mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import { redactSecrets, scrubTransportError } from '../../utils';
import type { MsTeamsConfig } from './ms-teams.config';
import { ADAPTIVE_CARD_SCHEMA } from './ms-teams.types';
import type { AdaptiveCard, MsTeamsNarrowedInput } from './ms-teams.types';

/**
 * Hosts of the Office 365 connector webhooks Microsoft is retiring in favor of
 * Workflows. Only these reliably answer `'1'` on success, so only these can
 * be judged by that body.
 */
function isLegacyConnectorHost(webhookUrl: string): boolean {
  let host: string;
  try {
    host = new URL(webhookUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'outlook.office.com' || host.endsWith('.webhook.office.com');
}

/**
 * Webhook-URL-as-auth. No Authorization header; the webhookUrl IS the
 * credential.
 *
 * Two webhook generations are accepted: Workflows webhooks (Power Automate /
 * Logic Apps "When a Teams webhook request is received"), which answer
 * `202 Accepted` with an empty body, and legacy Office 365 connector webhooks
 * (`*.webhook.office.com`, `outlook.office.com`), which answer HTTP 200 with
 * plain text `'1'`. Neither returns a message identifier, so
 * `providerMessageId` is always `null`.
 *
 * outlier: Teams' Incoming Webhook expects a fixed envelope —
 * `{ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: <card> }] }`.
 * The connector synthesizes this envelope locally; consumers needing legacy
 * MessageCard shapes can override via `_passthrough.body` (deep-merge).
 */
export class MsTeamsChatConnector
  extends BaseConnector
  implements IChatProvider, IChatConnector
{
  public readonly id = 'ms-teams' as const;
  public readonly channelType = ChannelTypeEnum.CHAT as ChannelTypeEnum.CHAT;

  constructor(private config: MsTeamsConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IChatConnector`.
   *
   * `to` is intentionally absent from `MsTeamsNarrowedInput` — the webhook URL
   * targets the channel directly. When `input.card` is unset, the
   * connector synthesizes a default Adaptive Card v1.4 with a single
   * `TextBlock` containing `input.body`. When `input.card` is set, it replaces
   * the synthesized card; `input.body` is NOT auto-inserted as a TextBlock.
   */
  async send(input: MsTeamsNarrowedInput): Promise<ChatSendResult> {
    if (!this.config.webhookUrl) {
      throw new ConnectorError({
        message:
          'MS Teams requires `webhookUrl` in config (webhook-URL-as-auth).',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'MS Teams requires `webhookUrl` in config (webhook-URL-as-auth).',
      });
    }

    assertHttpsWebhookUrl(this.config.webhookUrl, 'MS Teams');

    const card: AdaptiveCard =
      input.card ?? {
        type: 'AdaptiveCard',
        $schema: ADAPTIVE_CARD_SCHEMA,
        version: '1.4',
        body: [{ type: 'TextBlock', text: input.body, wrap: true }],
      };

    const connectorBody: Record<string, unknown> = {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: card,
        },
      ],
    };

    const { body: mergedBody, headers: mergedHeaders } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        { 'Content-Type': 'application/json' },
        input._passthrough,
      );

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.webhookUrl, {
        method: 'POST',
        headers: mergedHeaders,
        body: JSON.stringify(mergedBody),
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      // The webhook URL IS the credential; redact it from surfaced error text
      // and never store the raw fetch error.
      const err = error as Error;
      const cause = scrubTransportError(err);
      if (err?.name === 'AbortError') {
        throw new ConnectorError({
          message: redactSecrets(err.message ?? 'Request cancelled', [this.config.webhookUrl]),
          statusCode: null,
          providerCode: 'invalid_request',
          cause,
        });
      }
      throw new ConnectorError({
        message: redactSecrets(err.message ?? 'Network error', [this.config.webhookUrl]),
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause,
      });
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => null);
      throw this.mapVendorError(response.status, errorBody, response.headers);
    }

    const rawText = await response.text().catch(() => '');
    const failureStatus = this.failureStatusFor2xx(
      response.status,
      rawText,
      this.config.webhookUrl,
    );
    if (failureStatus !== null) {
      throw this.mapVendorError(failureStatus, rawText, response.headers);
    }
    return {
      success: true,
      status: 'sent',
      providerMessageId: null,
      raw: rawText,
    };
  }

  /**
   * Decides whether a 2xx response is really a failure, returning the
   * effective HTTP status to map, or `null` for success.
   *
   * - Workflows webhooks ("When a Teams webhook request is received") run on
   *   the Azure Logic Apps Request trigger, which answers **202 Accepted**
   *   with no body when the flow has no Response action — so 202 is success
   *   whatever the body says.
   * - Legacy Office 365 connector webhooks return plain text `"1"` on
   *   success, but on failure (including throttling) still answer HTTP 200
   *   with an error string such as
   *   "...Teams endpoint returned HTTP error 429 with ContextId...". The
   *   embedded code drives the taxonomy.
   * - Any other body from a legacy connector host is a failure (502) so it
   *   is not silently reported as sent. Workflows URLs may return whatever
   *   body the flow's Response action defines, so a non-legacy host's 2xx
   *   without the embedded error text is success.
   */
  private failureStatusFor2xx(
    status: number,
    rawText: string,
    webhookUrl: string,
  ): number | null {
    if (status === 202) return null;
    const embedded = /HTTP error (\d{3})/i.exec(rawText);
    if (embedded) return Number(embedded[1]);
    if (isLegacyConnectorHost(webhookUrl) && rawText.trim() !== '1') return 502;
    return null;
  }

  /**
   * HTTP-layer mapping. ConnectorError carries no
   * `retryAfterSeconds` field — retry is consumer policy:
   * parsed seconds embedded in `providerMessage` text, raw header preserved on
   * `cause.retryAfter`. Wrapper performs no retry.
   *
   * Teams-specific quirk: revoked / malformed webhook URLs return HTTP 400
   * with a plain-text body containing `Invalid webhook URL` — not 404 like
   * Slack/Discord. Special-cased to `auth_failed`.
   */
  private mapVendorError(
    statusCode: number,
    bodyText: string | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    const retryAfterSeconds = retryAfterHeader != null
      ? parseRetryAfter(retryAfterHeader)
      : null;

    const isInvalidWebhookBody =
      statusCode === 400 && /invalid webhook/i.test(bodyText ?? '');

    const providerCode: ProviderCode = isInvalidWebhookBody
      ? 'auth_failed'
      : statusCode === 401 || statusCode === 403 || statusCode === 404
        ? 'auth_failed'
        : statusCode === 429
          ? 'rate_limited'
          : statusCode === 400
            ? 'invalid_request'
            : statusCode >= 500
              ? 'provider_unavailable'
              : 'unknown';

    const baseMessage = bodyText ?? `MS Teams HTTP ${statusCode}`;

    const cause: Record<string, unknown> = { raw: bodyText };
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
    const webhookUrl = options.webhookUrl ?? this.config.webhookUrl;

    if (!webhookUrl) {
      // Config misuse is a pre-flight `invalid_request`, as on `.send()`.
      throw new ConnectorError({
        message:
          'Missing webhook URL: provide webhookUrl in options or config',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Missing webhook URL: provide webhookUrl in options or config',
      });
    }
    assertHttpsWebhookUrl(webhookUrl, 'MS Teams');

    const payload: Record<string, unknown> = {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            type: 'AdaptiveCard',
            $schema: ADAPTIVE_CARD_SCHEMA,
            version: '1.4',
            body: [
              {
                type: 'TextBlock',
                text: options.content,
                wrap: true,
              },
            ],
          },
        },
      ],
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...passthroughHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const err = error as Error;
      const cause = scrubTransportError(err);
      if (err?.name === 'AbortError') {
        throw new ConnectorError({
          message: redactSecrets(err.message ?? 'Request cancelled', [webhookUrl]),
          statusCode: null,
          providerCode: 'invalid_request',
          cause,
        });
      }
      throw new ConnectorError({
        message: redactSecrets(err.message ?? 'Network error', [webhookUrl]),
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause,
      });
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => null);
      throw this.mapVendorError(response.status, errText, response.headers);
    }

    // Legacy connectors report failures inside an HTTP 200 body, exactly as
    // on `.send()`.
    const rawText = await response.text().catch(() => '');
    const failureStatus = this.failureStatusFor2xx(response.status, rawText, webhookUrl);
    if (failureStatus !== null) {
      throw this.mapVendorError(failureStatus, rawText, response.headers);
    }

    return {
      id: undefined,
      date: new Date().toISOString(),
    };
  }
}
