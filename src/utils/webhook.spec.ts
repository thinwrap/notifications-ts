import { describe, it, expect, vi } from 'vitest';
import { ConnectorError } from '../types';
import { SlackChatConnector } from '../providers/slack/slack.connector';
import { DiscordChatConnector } from '../providers/discord/discord.connector';
import { MsTeamsChatConnector } from '../providers/ms-teams/ms-teams.connector';
import { GoogleChatChatConnector } from '../providers/google-chat/google-chat.connector';
import { MattermostChatConnector } from '../providers/mattermost/mattermost.connector';
import { RocketChatChatConnector } from '../providers/rocket-chat/rocket-chat.connector';
import { assertHttpsWebhookUrl } from './webhook';

// For webhook providers the URL is the credential, so a cleartext http:// URL
// must never be dialled — on .send() or on the Novu sendMessage() surface,
// where options.webhookUrl can override the configured one.
const HTTPS = 'https://example.test/hook/secret';
const HTTP = 'http://example.test/hook/secret';

type Chat = { sendMessage(o: { content: string; webhookUrl?: string }): Promise<unknown> };

const connectors: Array<[string, (f: typeof fetch) => Chat]> = [
  ['Slack', (f) => new SlackChatConnector({ webhookUrl: HTTPS }, f)],
  ['Discord', (f) => new DiscordChatConnector({ webhookUrl: HTTPS }, f)],
  ['MS Teams', (f) => new MsTeamsChatConnector({ webhookUrl: HTTPS }, f)],
  ['Google Chat', (f) => new GoogleChatChatConnector({ webhookUrl: HTTPS }, f)],
  ['Mattermost', (f) => new MattermostChatConnector({ webhookUrl: HTTPS }, f)],
];

describe('https-only webhook gate', () => {
  it.each(connectors)('%s sendMessage() rejects an http:// options.webhookUrl before any request', async (_name, make) => {
    const fetchMock = vi.fn();
    const err = await make(fetchMock as unknown as typeof fetch)
      .sendMessage({ content: 'x', webhookUrl: HTTP })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).providerCode).toBe('invalid_request');
    expect((err as ConnectorError).message).not.toContain('secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(connectors)('%s sendMessage() with no webhook URL → invalid_request (config misuse)', async (_name, make) => {
    const fetchMock = vi.fn();
    const c = make(fetchMock as unknown as typeof fetch) as Chat & { config?: unknown };
    // Construct without a configured URL by overriding it on the instance.
    (c as unknown as { config: { webhookUrl?: string } }).config.webhookUrl = undefined;
    const err = await c.sendMessage({ content: 'x' }).catch((e: unknown) => e);
    expect((err as ConnectorError).providerCode).toBe('invalid_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Rocket.Chat send() and sendMessage() reject an http:// webhookUrl before any request', async () => {
    const fetchMock = vi.fn();
    const rc = new RocketChatChatConnector({ webhookUrl: HTTP }, fetchMock as unknown as typeof fetch);
    const e1 = await rc.send({ body: 'x' }).catch((e: unknown) => e);
    const e2 = await rc.sendMessage({ content: 'x' }).catch((e: unknown) => e);
    for (const e of [e1, e2]) {
      expect(e).toBeInstanceOf(ConnectorError);
      expect((e as ConnectorError).providerCode).toBe('invalid_request');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts https:// case-insensitively', () => {
    expect(() => assertHttpsWebhookUrl('HTTPS://x.test/', 'X')).not.toThrow();
    expect(() => assertHttpsWebhookUrl('ftp://x.test/', 'X')).toThrow(ConnectorError);
  });
});
