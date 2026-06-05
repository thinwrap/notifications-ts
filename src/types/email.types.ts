import type { Passthrough } from './passthrough.type';
import type { ChannelTypeEnum } from './channel.enum';

export interface EmailAttachment {
  filename: string;
  contentType?: string;
  content: string | Buffer;
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
