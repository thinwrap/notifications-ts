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
import { redactSecrets, scrubTransportError } from '../../utils';
import type { TelegramConfig } from './telegram.config';
import type { TelegramNarrowedInput, TelegramResponse } from './telegram.types';

export class TelegramChatConnector
  extends BaseConnector
  implements IChatProvider, IChatConnector
{
  public readonly id = 'telegram';
  public readonly channelType = ChannelTypeEnum.CHAT as ChannelTypeEnum.CHAT;

  constructor(private config: TelegramConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  /**
   * Thinwrap-native send. Implements `IChatConnector`.
   * Builds a JSON body for Telegram's `POST /bot<token>/sendMessage` endpoint
   * with hand-mapped snake_case wire keys (no casing
   * middleware). Wire-key mapping for the nine narrowed fields is explicit
   * to avoid the "implicit casing contract" anti-pattern.
   */
  async send(input: TelegramNarrowedInput): Promise<ChatSendResult> {
    if (!input.to) {
      throw new ConnectorError({
        message: 'Telegram requires `to`',
        statusCode: 400,
        providerCode: 'invalid_request',
        providerMessage: 'Telegram requires `to` (chat_id or @channelname).',
        cause: null,
      });
    }

    const connectorBody: Record<string, unknown> = {
      chat_id: input.to,
      text: input.body,
    };
    if (input.parseMode !== undefined) connectorBody.parse_mode = input.parseMode;
    if (input.entities !== undefined) connectorBody.entities = input.entities;
    if (input.disableNotification !== undefined)
      connectorBody.disable_notification = input.disableNotification;
    if (input.protectContent !== undefined)
      connectorBody.protect_content = input.protectContent;
    if (input.replyParameters !== undefined)
      connectorBody.reply_parameters = input.replyParameters;
    if (input.replyMarkup !== undefined)
      connectorBody.reply_markup = input.replyMarkup;
    if (input.linkPreviewOptions !== undefined)
      connectorBody.link_preview_options = input.linkPreviewOptions;
    if (input.messageThreadId !== undefined)
      connectorBody.message_thread_id = input.messageThreadId;

    const { body: mergedBody, headers: mergedHeaders } = mergePassthrough<
      Record<string, unknown>
    >(
      connectorBody,
      { 'Content-Type': 'application/json' },
      input._passthrough,
    );

    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: mergedHeaders,
        body: JSON.stringify(mergedBody),
      });
    } catch (error) {
      // The bot token is embedded in the request URL path; redact it from
      // surfaced error text and never store the raw fetch error.
      const err = error as Error;
      const safeMessage = redactSecrets(err.message ?? 'Network error', [this.config.botToken]);
      const cause = scrubTransportError(err);
      if (err?.name === 'AbortError') {
        throw new ConnectorError({
          message: safeMessage,
          statusCode: null,
          providerCode: 'invalid_request',
          cause,
        });
      }
      throw new ConnectorError({
        message: safeMessage,
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause,
      });
    }

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | TelegramResponse
        | null;
      throw this.mapVendorError(response.status, errBody);
    }

    const raw = (await response.json()) as TelegramResponse;

    if (!raw.ok) {
      // Soft-rejection path: HTTP 200 with `ok: false`. Telegram emits this
      // for some validation cases. Route through the same mapper using the
      // body-supplied `error_code` (or 400 as a defensive fallback).
      throw this.mapTelegramSoftError(raw);
    }

    return {
      success: true,
      status: 'sent',
      providerMessageId:
        raw.result?.message_id != null ? String(raw.result.message_id) : null,
      raw,
    };
  }

  /**
   * HTTP-layer + soft-error mapping. Telegram emits `parameters.retry_after`
   * (integer seconds) in the JSON body, not a `Retry-After` HTTP header —
   * outlier., `ConnectorError` carries no
   * `retryAfterSeconds` field; the parsed integer is appended to
   * `providerMessage`, and the raw integer is placed in `cause.retryAfter`.
   */
  private mapVendorError(
    statusCode: number,
    body: TelegramResponse | null,
  ): ConnectorError {
    const description = body?.description;
    // Telegram emits retry_after in body, not Retry-After header outlier.
    const retryAfter = body?.parameters?.retry_after ?? null;

    const providerCode: ProviderCode =
      statusCode === 401
        ? 'auth_failed'
        : statusCode === 403
          ? 'auth_failed'
          : statusCode === 429
            ? 'rate_limited'
            : statusCode === 400 && /chat not found/i.test(description ?? '')
              ? 'invalid_recipient'
              : statusCode === 400 &&
                  /user_id_invalid|peer_id_invalid|chat_id_invalid/i.test(
                    description ?? '',
                  )
                ? 'invalid_recipient'
                : statusCode === 400
                  ? 'invalid_request'
                  : statusCode >= 500
                    ? 'provider_unavailable'
                    : 'unknown';

    const providerMessage = description ?? `Telegram HTTP ${statusCode}`;

    const cause: Record<string, unknown> = { raw: body ?? null };
    if (retryAfter != null) {
      cause.retryAfter = String(retryAfter);
      cause.retryAfterSeconds = retryAfter;
    }

    return new ConnectorError({
      message: providerMessage,
      statusCode,
      providerCode,
      providerMessage,
      cause,
    });
  }

  private mapTelegramSoftError(body: TelegramResponse): ConnectorError {
    const code = body.error_code ?? 400;
    return this.mapVendorError(code, body);
  }

  // ---------------------------------------------------------------------------
  // Brownfield Novu-shaped surface (Novu-compat)
  // ---------------------------------------------------------------------------

  async sendMessage(
    options: IChatOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const payload: Record<string, unknown> = {
      chat_id: options.channel,
      text: options.content,
      parse_mode: 'HTML',
    };

    const { body, headers: passthroughHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...passthroughHeaders,
          },
          body: JSON.stringify(body),
        }
      );
    } catch (error) {
      // The bot token is embedded in the request URL path; redact it from
      // surfaced error text and never store the raw fetch error.
      const err = error as Error;
      const safeMessage = redactSecrets(err.message ?? 'Network error', [this.config.botToken]);
      const cause = scrubTransportError(err);
      if (err?.name === 'AbortError') {
        throw new ConnectorError({
          message: safeMessage,
          statusCode: null,
          providerCode: 'invalid_request',
          cause,
        });
      }
      throw new ConnectorError({
        message: safeMessage,
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause,
      });
    }

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | TelegramResponse
        | null;
      throw this.mapVendorError(response.status, errBody);
    }

    const data = (await response.json()) as TelegramResponse;
    if (!data.ok) {
      throw this.mapTelegramSoftError(data);
    }

    return {
      id: String(data.result!.message_id),
      date: new Date().toISOString(),
    };
  }
}
