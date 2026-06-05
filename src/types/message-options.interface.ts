import type { ChannelTypeEnum } from './channel.enum';

export interface IAttachmentOptions {
  mime: string;
  file: Buffer;
  name?: string;
  channels?: ChannelTypeEnum[];
  cid?: string;
  disposition?: string;
}

export interface IEmailOptions {
  to: string[];
  subject: string;
  html: string;
  from?: string;
  text?: string;
  attachments?: IAttachmentOptions[];
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  senderName?: string;
  headers?: Record<string, string>;
  customData?: Record<string, any>;
}

export interface ISmsOptions {
  to: string;
  content: string;
  from?: string;
  attachments?: IAttachmentOptions[];
  customData?: Record<string, any>;
}

export interface IPushOptions {
  target: string[];
  title: string;
  content: string;
  payload: object;
  overrides?: {
    type?: 'notification' | 'data';
    data?: Record<string, string>;
    tag?: string;
    body?: string;
    icon?: string;
    badge?: number;
    color?: string;
    sound?: string;
    title?: string;
    android?: any;
    apns?: any;
    fcmOptions?: any;
    webPush?: any;
  };
  subscriber: object;
  step: {
    digest: boolean;
    events: object[] | undefined;
    total_count: number | undefined;
  };
}

export interface IChatOptions {
  webhookUrl?: string;
  channel?: string;
  content: string;
  customData?: Record<string, any>;
}
