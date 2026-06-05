import { BaseConnector } from '../../base/base.connector';
import type {
  ChatSendResult,
  IChatConnector,
  IChatOptions,
  IChatProvider,
  ISendMessageSuccessResponse,
} from '../../types';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../types';
import type { ProviderCode } from '../../types';
import { mergePassthrough } from '../../utils';
import { parseRetryAfter } from '../../utils';
import type { RocketChatConfig } from './rocket-chat.config';
import type {
  RocketChatNarrowedInput,
  SlackCompatAttachment,
} from './rocket-chat.types';

/**
 * Webhook-URL-as-auth: the webhook URL itself is the credential.
 *
 * Rocket.Chat Incoming Webhooks accept Slack-compatible JSON; the webhook URL
 * itself is the credential (no `X-Auth-Token` / `X-User-Id` headers). The
 * webhook returns `{ success: true }` JSON on success — no `message_id` is
 * surfaced, so `providerMessageId` is always `null`.
 *
 * The camelCase→snake_case mapping for Slack-compat attachment fields lives in
 * the private `toWireAttachment` method below (explicit
 * per-connector mapping, NOT generic middleware).
 */
export class RocketChatChatConnector
  extends BaseConnector
  implements IChatConnector, IChatProvider
{
  public readonly id = 'rocket-chat' as const;
  public readonly channelType = ChannelTypeEnum.CHAT as ChannelTypeEnum.CHAT;

  constructor(
    private readonly config: RocketChatConfig,
    fetchImpl?: typeof fetch,
  ) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IChatConnector`.
   *
   * `to` is intentionally absent from `RocketChatNarrowedInput` — the webhook
   * URL targets the (default) channel directly. Snake_case wire keys
   * inside attachments (`author_name`, `author_link`, `author_icon`,
   * `title_link`, `image_url`, `thumb_url`) are written explicitly
   * no `Casing` helper is invoked. Top-level Rocket.Chat fields
   * (`alias`, `avatar`, `emoji`, `channel`, `tmid`, `tshow`) are already
   * Rocket.Chat-wire-native and pass through verbatim.
   */
  async send(input: RocketChatNarrowedInput): Promise<ChatSendResult> {
    if (!this.config.webhookUrl) {
      throw new ConnectorError({
        message:
          'Rocket.Chat requires `webhookUrl` in config (webhook-URL-as-auth).',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage:
          'Rocket.Chat requires `webhookUrl` in config (webhook-URL-as-auth).',
      });
    }

    const connectorBody: Record<string, unknown> = { text: input.body };
    if (input.attachments !== undefined) {
      connectorBody.attachments = input.attachments.map((a) =>
        this.toWireAttachment(a),
      );
    }
    if (input.alias !== undefined) connectorBody.alias = input.alias;
    if (input.avatar !== undefined) connectorBody.avatar = input.avatar;
    if (input.emoji !== undefined) connectorBody.emoji = input.emoji;
    // read input.to (base ChatSendInput) and translate to wire `channel`.
    if (input.to !== undefined) connectorBody.channel = input.to;
    if (input.tmid !== undefined) connectorBody.tmid = input.tmid;
    if (input.tshow !== undefined) connectorBody.tshow = input.tshow;

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        connectorBody,
        { 'Content-Type': 'application/json' },
        input._passthrough,
      );

    let response: Response;
    try {
      const requestOptions: { headers: Record<string, string>; query?: Record<string, string> } = {
        headers: mergedHeaders,
      };
      if (Object.keys(mergedQuery).length > 0) {
        requestOptions.query = mergedQuery;
      }
      response = await this.sendPostJson(
        this.config.webhookUrl,
        mergedBody,
        requestOptions,
      );
    } catch (error) {
      // sendPostJson already wraps network errors in ConnectorError per
      // BaseConnector.invokeFetch — rethrow verbatim.
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError({
        message: (error as Error).message ?? 'Network error',
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: error },
      });
    }

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as
        | { success?: boolean; error?: string; message?: string }
        | null;
      throw this.mapVendorError(response.status, errorBody, response.headers);
    }

    // Rocket.Chat Incoming Webhooks return { success: true } JSON on success —
    // no message_id. `raw` carries the parsed JSON body (or {} if non-JSON).
    const raw = await response.json().catch(() => ({}));
    return {
      success: true,
      status: 'sent',
      providerMessageId: null,
      raw,
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
    return w;
  }

  /**
   * HTTP-layer mapping. ConnectorError carries no
   * `retryAfterSeconds` field — retry is consumer policy:
   * parsed seconds embedded in `providerMessage` text, raw header preserved on
   * `cause.retryAfter`. Wrapper performs no retry.
   *
   * 401/403/404 all map to `auth_failed` — invalid, disabled, or
   * deleted Incoming Webhook URLs are all credential failures.
   */
  private mapVendorError(
    statusCode: number,
    body:
      | { success?: boolean; error?: string; message?: string }
      | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const retryAfterHeader = responseHeaders.get('retry-after');
    // Use shared parseRetryAfter (RFC 7231 + HTTP-date support).
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

    const baseMessage =
      body?.error ?? body?.message ?? `Rocket.Chat HTTP ${statusCode}`;

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
  // Brownfield Novu-shaped surface (minimal Novu drop-in
  // Novu compat is best-effort, not a contract; Novu input is adapted to Thinwrap's
  // `.send()` path and the Novu success-response shape is reconstructed).
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: IChatOptions,
  ): Promise<ISendMessageSuccessResponse> {
    await this.send({ body: options.content });
    return {
      id: undefined,
      date: new Date().toISOString(),
    };
  }
}
