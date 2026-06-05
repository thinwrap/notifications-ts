import type { Passthrough } from './passthrough.type';
import type { ChannelTypeEnum } from './channel.enum';

export interface SmsSendInput {
  from?: string;
  to: string;
  body: string;
  _passthrough?: Passthrough;
}

export interface SmsSendResult {
  success: boolean;
  status: 'sent' | 'queued' | 'rejected' | 'suppressed' | 'unknown';
  providerMessageId: string | null;
  raw: unknown;
}

export interface ISmsConnector {
  readonly id: string;
  readonly channelType: ChannelTypeEnum.SMS;
  send(input: SmsSendInput): Promise<SmsSendResult>;
}
