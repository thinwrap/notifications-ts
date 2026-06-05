import { BaseConnector } from '../../base/base.connector';
import type {
  IEmailOptions,
  IEmailProvider,
  ISendMessageSuccessResponse,
  WithPassthrough,
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
import type { ResendConfig } from './resend.config';
import type {
  ResendSendEmailResponse,
  ResendErrorResponse,
} from './resend.types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export class ResendEmailConnector
  extends BaseConnector
  implements IEmailProvider, IEmailConnector
{
  public readonly id = 'resend';
  public readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;

  constructor(private config: ResendConfig, fetchImpl?: typeof fetch) {
    super(fetchImpl ?? config.fetch);
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const requestBody = this.buildResendBody(input);

    const { body: mergedBody, headers: mergedHeaders, query: mergedQuery } =
      mergePassthrough<Record<string, unknown>>(
        requestBody,
        {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        input._passthrough,
      );

    const queryString = buildQueryString(mergedQuery);
    const url = `${RESEND_ENDPOINT}${queryString}`;
    const serializedBody = JSON.stringify(mergedBody);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: mergedHeaders,
        body: serializedBody,
      });
    } catch (error) {
      throw mapNetworkError(error);
    }

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | ResendErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const raw = (await response.json()) as ResendSendEmailResponse;
    return {
      success: true,
      status: 'sent',
      providerMessageId: raw.id ?? null,
      raw,
    };
  }

  private buildResendBody(input: EmailSendInput): Record<string, unknown> {
    const senderName = this.config.senderName;
    const fromAddress = input.from || this.config.from;
    const fromEmailAddress = senderName
      ? `${senderName} <${fromAddress}>`
      : fromAddress;

    const body: Record<string, unknown> = {
      from: fromEmailAddress,
      to: Array.isArray(input.to) ? input.to : [input.to],
      subject: input.subject,
    };

    if (input.html) body.html = input.html;
    if (input.text) body.text = input.text;
    if (input.cc && input.cc.length > 0) {
      body.cc = Array.isArray(input.cc) ? input.cc : [input.cc];
    }
    if (input.bcc && input.bcc.length > 0) {
      body.bcc = Array.isArray(input.bcc) ? input.bcc : [input.bcc];
    }
    if (input.replyTo) body.reply_to = input.replyTo;
    if (input.headers) body.headers = input.headers;
    if (input.tags && input.tags.length > 0) {
      body.tags = input.tags.map((t) => ({ name: 'tag', value: t }));
    }

    if (input.attachments && input.attachments.length > 0) {
      body.attachments = input.attachments.map((a) => {
        const content =
          typeof a.content === 'string'
            ? encodeBase64Ascii(a.content)
            : encodeBase64Bytes(a.content);
        const mapped: Record<string, unknown> = {
          filename: a.filename,
          content,
        };
        if (a.contentType) mapped.content_type = a.contentType;
        return mapped;
      });
    }

    const narrowed = input as EmailSendInput & { scheduledAt?: string };
    if (narrowed.scheduledAt) body.scheduled_at = narrowed.scheduledAt;

    return body;
  }

  private mapVendorError(
    status: number,
    body: ResendErrorResponse | null,
    responseHeaders: Headers,
  ): ConnectorError {
    const errorMessage = body?.message ?? '<no vendor message>';
    const providerCode = mapResendErrorToProviderCode(status, errorMessage);

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
    options: IEmailOptions,
    bridgeProviderData: WithPassthrough<Record<string, unknown>> = {}
  ): Promise<ISendMessageSuccessResponse> {
    const senderName = options.senderName ?? this.config.senderName;
    const from = options.from ?? this.config.from;
    const fromAddress = senderName ? `${senderName} <${from}>` : from;

    const payload: Record<string, unknown> = {
      from: fromAddress,
      to: options.to,
      subject: options.subject,
    };

    if (options.html) payload.html = options.html;
    if (options.text) payload.text = options.text;
    if (options.cc && options.cc.length > 0) payload.cc = options.cc;
    if (options.bcc && options.bcc.length > 0) payload.bcc = options.bcc;
    if (options.replyTo) payload.reply_to = options.replyTo;

    if (options.attachments && options.attachments.length > 0) {
      payload.attachments = options.attachments.map((a) => ({
        filename: a.name ?? 'attachment',
        content: encodeBase64Bytes(a.file),
        content_type: a.mime,
      }));
    }

    const { body, headers: mergedHeaders } = mergePassthrough(
      payload,
      {},
      bridgeProviderData._passthrough,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          ...mergedHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw mapNetworkError(error);
    }

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as
        | ResendErrorResponse
        | null;
      throw this.mapVendorError(response.status, errBody, response.headers);
    }

    const data = (await response.json()) as ResendSendEmailResponse;
    return {
      id: data.id,
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

function mapNetworkError(error: unknown): ConnectorError {
  if ((error as Error)?.name === 'AbortError') {
    return new ConnectorError({
      message: (error as Error).message ?? 'Request cancelled',
      statusCode: null,
      providerCode: 'invalid_request',
      cause: error,
    });
  }
  return new ConnectorError({
    message: (error as Error).message ?? 'Network error',
    statusCode: null,
    providerCode: 'provider_unavailable',
    cause: { raw: error },
  });
}

function mapResendErrorToProviderCode(
  status: number,
  message: string,
): ProviderCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  if (status === 404) return 'invalid_request';

  if (status === 422 || status === 400) {
    return /recipient|email address/i.test(message)
      ? 'invalid_recipient'
      : 'invalid_request';
  }

  return 'unknown';
}
