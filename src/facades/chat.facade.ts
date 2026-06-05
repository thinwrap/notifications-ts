import type { ProviderConfigMap, ChatProvider } from '../types';
import type {
  ChatSendInput,
  ChatSendResult,
  IChatConnector,
} from '../types';
import type { ChatInputMap } from '../types/input-map.type';
import { ChannelTypeEnum } from '../types';
import { ConnectorError } from '../types';
import { TelegramChatConnector } from '../providers/telegram';
import { SlackChatConnector } from '../providers/slack';
import { WhatsAppChatConnector } from '../providers/whatsapp-business';
import { DiscordChatConnector } from '../providers/discord';
import { MsTeamsChatConnector } from '../providers/ms-teams';
import { GoogleChatChatConnector } from '../providers/google-chat';
import { MattermostChatConnector } from '../providers/mattermost';
import { RocketChatChatConnector } from '../providers/rocket-chat';
import { LineChatConnector } from '../providers/line';

type ChatFacadeInput<P extends ChatProvider> = P extends keyof ChatInputMap
  ? ChatInputMap[P]
  : ChatSendInput;

type ChatConfigWithFetch<P extends ChatProvider> = ProviderConfigMap[P] & {
  fetch?: typeof fetch;
};

export class Chat<P extends ChatProvider = ChatProvider> {
  public readonly id: string;
  public readonly channelType = ChannelTypeEnum.CHAT;
  private readonly connector: IChatConnector;

  constructor(providerId: P, config: ChatConfigWithFetch<P>);
  constructor(connector: IChatConnector);
  constructor(arg: P | IChatConnector, config?: ChatConfigWithFetch<P>) {
    if (typeof arg === 'object' && arg !== null) {
      this.id = arg.id;
      this.connector = arg;
      return;
    }
    if (!config) {
      throw new ConnectorError({
        message: 'Chat facade requires `config` when constructed with a provider id',
        statusCode: null,
        providerCode: 'invalid_request',
      });
    }
    const providerId = arg;
    this.id = providerId;
    const customFetch = config.fetch;
    switch (providerId) {
      case 'telegram':
        this.connector = new TelegramChatConnector(config as ProviderConfigMap['telegram'], customFetch);
        break;
      case 'slack':
        this.connector = new SlackChatConnector(config as ProviderConfigMap['slack'], customFetch);
        break;
      case 'whatsapp-business':
        this.connector = new WhatsAppChatConnector(config as ProviderConfigMap['whatsapp-business'], customFetch);
        break;
      case 'discord':
        this.connector = new DiscordChatConnector(config as ProviderConfigMap['discord'], customFetch);
        break;
      case 'ms-teams':
        this.connector = new MsTeamsChatConnector(config as ProviderConfigMap['ms-teams'], customFetch);
        break;
      case 'google-chat':
        this.connector = new GoogleChatChatConnector(config as ProviderConfigMap['google-chat'], customFetch);
        break;
      case 'mattermost':
        this.connector = new MattermostChatConnector(config as ProviderConfigMap['mattermost'], customFetch);
        break;
      case 'rocket-chat':
        this.connector = new RocketChatChatConnector(config as ProviderConfigMap['rocket-chat'], customFetch);
        break;
      case 'line':
        this.connector = new LineChatConnector(config as ProviderConfigMap['line'], customFetch);
        break;
      default:
        throw new ConnectorError({
          message: `Unsupported chat provider: ${providerId as string}`,
          statusCode: null,
          providerCode: 'invalid_request',
        });
    }
  }

  async send(input: ChatFacadeInput<P>): Promise<ChatSendResult> {
    return this.connector.send(input as ChatSendInput);
  }

  async checkIntegration(): Promise<{ success: boolean; message?: string }> {
    const c = this.connector as IChatConnector & {
      checkIntegration?: () => Promise<unknown>;
    };
    if (typeof c.checkIntegration === 'function') {
      try {
        const result = await c.checkIntegration();
        return { success: true, message: JSON.stringify(result) };
      } catch (err) {
        return { success: false, message: (err as Error).message };
      }
    }
    return { success: true, message: 'connector does not implement checkIntegration' };
  }
}
