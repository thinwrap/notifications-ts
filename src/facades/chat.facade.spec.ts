import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Chat } from './chat.facade';
import { TelegramChatConnector } from '../providers/telegram';
import { SlackChatConnector } from '../providers/slack';
import { WhatsAppChatConnector } from '../providers/whatsapp-business';
import { DiscordChatConnector } from '../providers/discord';
import { MsTeamsChatConnector } from '../providers/ms-teams';
import { GoogleChatChatConnector } from '../providers/google-chat';
import { MattermostChatConnector } from '../providers/mattermost';
import { RocketChatChatConnector } from '../providers/rocket-chat';
import { LineChatConnector } from '../providers/line';
import type { ChatSendInput, ChatSendResult } from '../types';
import type { LineConfig } from '../providers/line';

vi.mock('../providers/telegram');
vi.mock('../providers/slack');
vi.mock('../providers/whatsapp-business');
vi.mock('../providers/discord');
vi.mock('../providers/ms-teams');
vi.mock('../providers/google-chat');
vi.mock('../providers/mattermost');
vi.mock('../providers/rocket-chat');
vi.mock('../providers/line');

const MockedTelegram = vi.mocked(TelegramChatConnector);
const MockedSlack = vi.mocked(SlackChatConnector);
const MockedWhatsApp = vi.mocked(WhatsAppChatConnector);
const MockedDiscord = vi.mocked(DiscordChatConnector);
const MockedMsTeams = vi.mocked(MsTeamsChatConnector);
const MockedGoogleChat = vi.mocked(GoogleChatChatConnector);
const MockedMattermost = vi.mocked(MattermostChatConnector);
const MockedRocketChat = vi.mocked(RocketChatChatConnector);
const MockedLine = vi.mocked(LineChatConnector);

const sendInput = {
  to: 'destination',
  body: 'Hello',
} satisfies ChatSendInput;

describe('Chat facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('instantiates TelegramChatConnector for "telegram"', () => {
    const config = { botToken: 'bot-token' };
    const facade = new Chat('telegram', config);

    expect(facade.id).toBe('telegram');
    expect(MockedTelegram).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates SlackChatConnector for "slack"', () => {
    const config = { webhookUrl: 'https://hooks.slack.com/test' };
    const facade = new Chat('slack', config);

    expect(facade.id).toBe('slack');
    expect(MockedSlack).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates WhatsAppChatConnector for "whatsapp-business"', () => {
    const config = { accessToken: 'token', phoneNumberId: '123' };
    const facade = new Chat('whatsapp-business', config);

    expect(facade.id).toBe('whatsapp-business');
    expect(MockedWhatsApp).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates DiscordChatConnector for "discord"', () => {
    const config = { webhookUrl: 'https://discord.com/api/webhooks/123/abc' };
    const facade = new Chat('discord', config);

    expect(facade.id).toBe('discord');
    expect(MockedDiscord).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates MsTeamsChatConnector for "ms-teams"', () => {
    const config = { webhookUrl: 'https://region.logic.azure.com/workflows/abc' };
    const facade = new Chat('ms-teams', config);

    expect(facade.id).toBe('ms-teams');
    expect(MockedMsTeams).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates GoogleChatChatConnector for "google-chat"', () => {
    const config = { webhookUrl: 'https://chat.googleapis.com/v1/spaces/xxx/messages?key=yyy' };
    const facade = new Chat('google-chat', config);

    expect(facade.id).toBe('google-chat');
    expect(MockedGoogleChat).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates MattermostChatConnector for "mattermost"', () => {
    const config = { webhookUrl: 'https://mattermost.example.com/hooks/xxx' };
    const facade = new Chat('mattermost', config);

    expect(facade.id).toBe('mattermost');
    expect(MockedMattermost).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates RocketChatChatConnector for "rocket-chat"', () => {
    const config = { webhookUrl: 'https://rocket.example.com/hooks/xxx/yyy' };
    const facade = new Chat('rocket-chat', config);

    expect(facade.id).toBe('rocket-chat');
    expect(MockedRocketChat).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates LineChatConnector for "line"', () => {
    const config = { channelAccessToken: 'line-token' };
    const facade = new Chat('line', config);

    expect(facade.id).toBe('line');
    expect(MockedLine).toHaveBeenCalledWith(config, undefined);
  });

  it('forwards `config.fetch` through to the connector constructor', () => {
    const customFetch = vi.fn() as unknown as typeof fetch;
    const config = { botToken: 'bot-token', fetch: customFetch };
    new Chat('telegram', config);
    expect(MockedTelegram).toHaveBeenCalledWith(config, customFetch);
  });

  it('accepts a custom IChatConnector instance', () => {
    const customConnector = {
      id: 'custom-chat',
      channelType: 'chat' as const,
      send: vi.fn().mockResolvedValue({
        success: true,
        status: 'sent',
        providerMessageId: 'msg-1',
        raw: {},
      }),
    };
    const facade = new Chat(customConnector as never);
    expect(facade.id).toBe('custom-chat');
  });

  it('forwards .send(input) to the connector', async () => {
    const result: ChatSendResult = {
      success: true,
      status: 'sent',
      providerMessageId: 'telegram-msg-1',
      raw: { ok: true, result: { message_id: 1 } },
    };
    const sendMock = vi.fn().mockResolvedValue(result);
    MockedTelegram.prototype.send = sendMock;

    const facade = new Chat('telegram', { botToken: 'bot-token' });
    const actual = await facade.send(sendInput);

    expect(sendMock).toHaveBeenCalledWith(sendInput);
    expect(actual).toEqual(result);
  });

  it('throws for unsupported provider id', () => {
    expect(
      () => new Chat('unknown' as 'telegram', { botToken: 'bot-token' }),
    ).toThrow('Unsupported chat provider: unknown');
  });

  it('rejects mismatched config types at compile time', () => {
    const lineCfg: LineConfig = { channelAccessToken: 'line-token' };
    // @ts-expect-error — LineConfig (lacks accessToken/phoneNumberId) does not satisfy WhatsAppBusinessConfig.
    new Chat('whatsapp-business', lineCfg);
    expect(true).toBe(true);
  });
});
