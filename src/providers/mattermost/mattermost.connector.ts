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
import { redactSecrets, scrubTransportError } from '../../utils';
import type { MattermostConfig } from './mattermost.config';
import type {
  MattermostNarrowedInput,
  SlackCompatAttachment,
} from './mattermost.types';

/**
 * Webhook-URL-as-auth. No Authorization header; the webhookUrl IS the
 * credential.
 *
 * Mattermost Incoming Webhooks return plain text `"ok"` on success (HTTP 200)
 * and an error string on failure — non-JSON body parsing throughout. No
 * message_id is returned, so `providerMessageId` is always `null`.
 *
 * Mattermost adopted Slack's legacy attachment format verbatim. The
 * camelCase→snake_case mapping for attachment fields lives in the private
 * `toWireAttachment` method below (explicit per-connector
 * mapping, NOT generic middleware).
 */
export class MattermostChatConnector
  extends BaseConnector
  implements IChatProvider, IChatConnector
{
  public readonly id = 'mattermost' as const;
  public readonly channelType = ChannelTypeEnum.CHAT as ChannelTypeEnum.CHAT;

  constructor(private config: MattermostConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IChatConnector`.
   *
   * `to` is intentionally absent from `MattermostNarrowedInput` — the webhook
   * URL targets the (default) channel directly. All snake_case wire
   * keys (`icon_url`, `icon_emoji`, and per-attachment `author_name`,
   * `author_link`, `author_icon`, `title_link`, `image_url`, `thumb_url`,
   * `footer_icon`) are written explicitly; no `Casing`
   * helper is invoked.
   */
  async send(input: MattermostNarrowedInput): Promise<ChatSendResult> {
    if (!this.config.webhookUrl) {
      throw new ConnectorError({
        message:
          'Mattermost requires `webhookUrl` in config (webhook-URL-as-auth).',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Mattermost requires `webhookUrl` in config (webhook-URL-as-auth).',
      });
    }

    if (!/^https:\/\//i.test(this.config.webhookUrl)) {
      // The webhook URL IS the credential; refuse cleartext http so a
      // stale/typo'd config cannot leak the token over the wire.
      throw new ConnectorError({
        message: 'Mattermost webhookUrl must be an https:// URL.',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage: 'Mattermost webhookUrl must be an https:// URL.',
      });
    }

    const connectorBody: Record<string, unknown> = { text: input.body };
    if (input.attachments !== undefined) {
      connectorBody.attachments = input.attachments.map((a) =>
        this.toWireAttachment(a),
      );
    }
    if (input.username !== undefined) connectorBody.username = input.username;
    if (input.iconUrl !== undefined) connectorBody.icon_url = input.iconUrl;
    if (input.iconEmoji !== undefined) connectorBody.icon_emoji = input.iconEmoji;
    // read input.to (base ChatSendInput) and translate to wire `channel`.
    if (input.to !== undefined) connectorBody.channel = input.to;
    if (input.props !== undefined) connectorBody.props = input.props;
    if (input.type !== undefined) connectorBody.type = input.type;

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

    // Mattermost Incoming Webhooks return plain text "ok" on success — no
    // JSON, no message_id. `raw` carries the response body verbatim.
    const rawText = await response.text().catch(() => '');
    return {
      success: true,
      status: 'sent',
      providerMessageId: null,
      raw: rawText,
    };
  }

  /**
   * Map camelCase narrowed attachment fields to Slack-compat snake_case wire
   * keys. Lives on the connector (NOT a shared utility):
   * explicit per-connector mapping for the Slack-compat-attachment-shape
   * contract this connector owns.
   *
   * Same-form fields (`color`, `pretext`, `title`, `text`, `fields`, `footer`,
   * `timestamp`, `fallback`) pass through untouched. Unknown extension keys
   * are preserved verbatim via the `[k: string]: unknown` index signature.
   */
  private toWireAttachment(att: SlackCompatAttachment): Record<string, unknown> {
    const w: Record<string, unknown> = { ...att };
    if (att.authorName !== undefined) {
      w.author_name = att.authorName;
      delete w.authorName;
    }
    if (att.authorLink !== undefined) {
      w.author_link = att.authorLink;
      delete w.authorLink;
    }
    if (att.authorIcon !== undefined) {
      w.author_icon = att.authorIcon;
      delete w.authorIcon;
    }
    if (att.titleLink !== undefined) {
      w.title_link = att.titleLink;
      delete w.titleLink;
    }
    if (att.imageUrl !== undefined) {
      w.image_url = att.imageUrl;
      delete w.imageUrl;
    }
    if (att.thumbUrl !== undefined) {
      w.thumb_url = att.thumbUrl;
      delete w.thumbUrl;
    }
    if (att.footerIcon !== undefined) {
      w.footer_icon = att.footerIcon;
      delete w.footerIcon;
    }
    return w;
  }

  /**
   * HTTP-layer mapping. ConnectorError carries no
   * `retryAfterSeconds` field — retry is consumer policy:
   * parsed seconds embedded in `providerMessage` text, raw header preserved on
   * `cause.retryAfter`. Wrapper performs no retry.
   *
   * 401/403/404 all map to `auth_failed` — invalid, revoked, or
   * non-existent Incoming Webhook IDs are all credential failures.
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

    const providerCode: ProviderCode =
      statusCode === 401 || statusCode === 403 || statusCode === 404
        ? 'auth_failed'
        : statusCode === 429
          ? 'rate_limited'
          : statusCode === 400
            ? 'invalid_request'
            : statusCode >= 500
              ? 'provider_unavailable'
              : 'unknown';

    const baseMessage = bodyText ?? `Mattermost HTTP ${statusCode}`;

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
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: IChatOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const webhookUrl = options.webhookUrl ?? this.config.webhookUrl;

    if (!webhookUrl) {
      throw new ConnectorError({
        message:
          'Missing webhook URL: provide webhookUrl in options or config',
        statusCode: 400,
      });
    }

    const payload: Record<string, unknown> = {
      text: options.content,
    };

    if (options.channel) {
      payload.channel = options.channel;
    }

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

    return {
      id: undefined,
      date: new Date().toISOString(),
    };
  }
}
