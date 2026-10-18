import type { Passthrough } from './passthrough.type';
import type { ChannelTypeEnum } from './channel.enum';

export interface EmailAttachment {
  filename: string;
  contentType?: string;
  /**
   * A string is sent as its UTF-8 bytes. Bytes are typed as `Uint8Array` (a
   * Node `Buffer` is one) so the public types do not require `@types/node`.
   */
  content: string | Uint8Array;
  contentId?: string;
}

export interface EmailSendInput {
  from: string;
  to: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
  tags?: string[];
  _passthrough?: Passthrough;
}

export interface EmailSendResult {
  success: boolean;
  status: 'sent' | 'queued' | 'rejected' | 'suppressed' | 'unknown';
  providerMessageId: string | null;
  raw: unknown;
}

export interface IEmailConnector {
  readonly id: string;
  readonly channelType: ChannelTypeEnum.EMAIL;
  send(input: EmailSendInput): Promise<EmailSendResult>;
}
