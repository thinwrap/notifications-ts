import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Email } from './email.facade';
import { SesEmailConnector } from '../providers/ses';
import { ResendEmailConnector } from '../providers/resend';
import { MailgunEmailConnector } from '../providers/mailgun';
import { SendgridEmailConnector } from '../providers/sendgrid';
import { PostmarkEmailConnector } from '../providers/postmark';
import { MailerSendEmailConnector } from '../providers/mailersend';
import { MailtrapEmailConnector } from '../providers/mailtrap';
import { BrevoEmailConnector } from '../providers/brevo';
import { SparkPostEmailConnector } from '../providers/sparkpost';
import { ScalewayEmailConnector } from '../providers/scaleway';
import type { EmailSendInput, EmailSendResult } from '../types';
import type { PostmarkConfig } from '../providers/postmark';

vi.mock('../providers/ses');
vi.mock('../providers/resend');
vi.mock('../providers/mailgun');
vi.mock('../providers/sendgrid');
vi.mock('../providers/postmark');
vi.mock('../providers/mailersend');
vi.mock('../providers/mailtrap');
vi.mock('../providers/brevo');
vi.mock('../providers/sparkpost');
vi.mock('../providers/scaleway');

const MockedSes = vi.mocked(SesEmailConnector);
const MockedResend = vi.mocked(ResendEmailConnector);
const MockedMailgun = vi.mocked(MailgunEmailConnector);
const MockedSendgrid = vi.mocked(SendgridEmailConnector);
const MockedPostmark = vi.mocked(PostmarkEmailConnector);
const MockedMailerSend = vi.mocked(MailerSendEmailConnector);
const MockedMailtrap = vi.mocked(MailtrapEmailConnector);
const MockedBrevo = vi.mocked(BrevoEmailConnector);
const MockedSparkPost = vi.mocked(SparkPostEmailConnector);
const MockedScaleway = vi.mocked(ScalewayEmailConnector);

const sendInput = {
  from: 'sender@example.com',
  to: 'recipient@example.com',
  subject: 'Hello',
  text: 'Hi there',
} satisfies EmailSendInput;

describe('Email facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('instantiates SesEmailConnector for "ses"', () => {
    const config = {
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      from: 'a@b.com',
      senderName: 'S',
    };
    const facade = new Email('ses', config);

    expect(facade.id).toBe('ses');
    expect(MockedSes).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates ResendEmailConnector for "resend"', () => {
    const config = { apiKey: 'key', from: 'a@b.com' };
    const facade = new Email('resend', config);

    expect(facade.id).toBe('resend');
    expect(MockedResend).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates MailgunEmailConnector for "mailgun"', () => {
    const config = { apiKey: 'key', domain: 'mg.example.com', from: 'a@b.com' };
    const facade = new Email('mailgun', config);

    expect(facade.id).toBe('mailgun');
    expect(MockedMailgun).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates SendgridEmailConnector for "sendgrid"', () => {
    const config = { apiKey: 'SG.test', from: 'a@b.com' };
    const facade = new Email('sendgrid', config);

    expect(facade.id).toBe('sendgrid');
    expect(MockedSendgrid).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates PostmarkEmailConnector for "postmark"', () => {
    const config = { serverToken: 'pm-test', from: 'a@b.com' };
    const facade = new Email('postmark', config);

    expect(facade.id).toBe('postmark');
    expect(MockedPostmark).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates MailerSendEmailConnector for "mailersend"', () => {
    const config = { apiToken: 'token', from: 'a@b.com' };
    const facade = new Email('mailersend', config);

    expect(facade.id).toBe('mailersend');
    expect(MockedMailerSend).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates MailtrapEmailConnector for "mailtrap"', () => {
    const config = { apiToken: 'token', mode: 'production' as const, from: 'a@b.com' };
    const facade = new Email('mailtrap', config);

    expect(facade.id).toBe('mailtrap');
    expect(MockedMailtrap).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates BrevoEmailConnector for "brevo"', () => {
    const config = { apiKey: 'key', from: 'a@b.com' };
    const facade = new Email('brevo', config);

    expect(facade.id).toBe('brevo');
    expect(MockedBrevo).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates SparkPostEmailConnector for "sparkpost"', () => {
    const config = { apiKey: 'key', from: 'a@b.com' };
    const facade = new Email('sparkpost', config);

    expect(facade.id).toBe('sparkpost');
    expect(MockedSparkPost).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates ScalewayEmailConnector for "scaleway"', () => {
    const config = { secretKey: 'k', projectId: 'p', from: 'a@b.com' };
    const facade = new Email('scaleway', config);

    expect(facade.id).toBe('scaleway');
    expect(MockedScaleway).toHaveBeenCalledWith(config, undefined);
  });

  it('forwards `config.fetch` through to the connector constructor', () => {
    const customFetch = vi.fn() as unknown as typeof fetch;
    const config = {
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      from: 'a@b.com',
      senderName: 'S',
      fetch: customFetch,
    };
    new Email('ses', config);
    expect(MockedSes).toHaveBeenCalledWith(config, customFetch);
  });

  it('accepts a custom IEmailConnector instance', () => {
    const customConnector = {
      id: 'custom-email',
      channelType: 'email' as const,
      send: vi.fn().mockResolvedValue({
        success: true,
        status: 'sent',
        providerMessageId: 'msg-1',
        raw: {},
      }),
    };
    const facade = new Email(customConnector as never);
    expect(facade.id).toBe('custom-email');
  });

  it('forwards .send(input) to the connector', async () => {
    const result: EmailSendResult = {
      success: true,
      status: 'sent',
      providerMessageId: 'ses-msg-1',
      raw: { MessageId: 'ses-msg-1' },
    };
    const sendMock = vi.fn().mockResolvedValue(result);
    MockedSes.prototype.send = sendMock;

    const facade = new Email('ses', {
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      from: 'a@b.com',
      senderName: 'S',
    });
    const actual = await facade.send(sendInput);

    expect(sendMock).toHaveBeenCalledWith(sendInput);
    expect(actual).toEqual(result);
  });

  it('throws for unsupported provider id', () => {
    expect(() =>
      new Email('unknown' as 'ses', {
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        from: 'a@b.com',
        senderName: 'S',
      }),
    ).toThrow('Unsupported email provider: unknown');
  });

  it('rejects mismatched config types at compile time', () => {
    const postmarkCfg: PostmarkConfig = { serverToken: 'pm-token', from: 'a@b.com' };
    // @ts-expect-error — postmark config (lacks apiKey) does not satisfy SendgridConfig.
    new Email('sendgrid', postmarkCfg);
    expect(true).toBe(true);
  });
});
