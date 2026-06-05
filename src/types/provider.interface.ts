import type { ChannelTypeEnum } from './channel.enum';
import type { IEmailOptions, ISmsOptions, IPushOptions, IChatOptions } from './message-options.interface';
import type { ISendMessageSuccessResponse, ICheckIntegrationResponse } from './response.interface';

export interface IProvider {
  id: string;
  channelType: ChannelTypeEnum;
}

export interface IEmailProvider extends IProvider {
  channelType: ChannelTypeEnum.EMAIL;
  sendMessage(
    options: IEmailOptions,
    bridgeProviderData?: Record<string, unknown>
  ): Promise<ISendMessageSuccessResponse>;
  checkIntegration?(
    options: IEmailOptions
  ): Promise<ICheckIntegrationResponse>;
}

export interface ISmsProvider extends IProvider {
  channelType: ChannelTypeEnum.SMS;
  sendMessage(
    options: ISmsOptions,
    bridgeProviderData?: Record<string, unknown>
  ): Promise<ISendMessageSuccessResponse>;
}

export interface IPushProvider extends IProvider {
  channelType: ChannelTypeEnum.PUSH;
  sendMessage(
    options: IPushOptions,
    bridgeProviderData?: Record<string, unknown>
  ): Promise<ISendMessageSuccessResponse>;
}

export interface IChatProvider extends IProvider {
  channelType: ChannelTypeEnum.CHAT;
  sendMessage(
    options: IChatOptions,
    bridgeProviderData?: Record<string, unknown>
  ): Promise<ISendMessageSuccessResponse>;
}
