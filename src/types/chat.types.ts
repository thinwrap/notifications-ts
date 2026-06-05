import type { Passthrough } from './passthrough.type';
import type { ChannelTypeEnum } from './channel.enum';

export interface ChatSendInput {
  to?: string;
  body: string;
  _passthrough?: Passthrough;
}

export interface ChatSendResult {
  success: boolean;
  status: 'sent' | 'queued' | 'rejected' | 'suppressed' | 'unknown';
  providerMessageId: string | null;
  raw: unknown;
}

export interface IChatConnector {
  readonly id: string;
  readonly channelType: ChannelTypeEnum.CHAT;
  send(input: ChatSendInput): Promise<ChatSendResult>;
}
