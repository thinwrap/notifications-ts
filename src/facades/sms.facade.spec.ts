import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Sms } from './sms.facade';
import { VonageSmsConnector } from '../providers/vonage';
import { TwilioSmsConnector } from '../providers/twilio';
import { PlivoSmsConnector } from '../providers/plivo';
import { SnsSmsConnector } from '../providers/sns';
import { SinchSmsConnector } from '../providers/sinch';
import { TelnyxSmsConnector } from '../providers/telnyx';
import { InfobipSmsConnector } from '../providers/infobip';
import { MessageBirdSmsConnector } from '../providers/messagebird';
import { TextmagicSmsConnector } from '../providers/textmagic';
import { D7NetworksSmsConnector } from '../providers/d7networks';
import type { SmsSendInput, SmsSendResult } from '../types';
import type { TwilioConfig } from '../providers/twilio';
import type { SnsConfig } from '../providers/sns';

vi.mock('../providers/vonage');
vi.mock('../providers/twilio');
vi.mock('../providers/plivo');
vi.mock('../providers/sns');
vi.mock('../providers/sinch');
vi.mock('../providers/telnyx');
vi.mock('../providers/infobip');
vi.mock('../providers/messagebird');
vi.mock('../providers/textmagic');
vi.mock('../providers/d7networks');

const MockedVonage = vi.mocked(VonageSmsConnector);
const MockedTwilio = vi.mocked(TwilioSmsConnector);
const MockedPlivo = vi.mocked(PlivoSmsConnector);
const MockedSns = vi.mocked(SnsSmsConnector);
const MockedSinch = vi.mocked(SinchSmsConnector);
const MockedTelnyx = vi.mocked(TelnyxSmsConnector);
const MockedInfobip = vi.mocked(InfobipSmsConnector);
const MockedMessageBird = vi.mocked(MessageBirdSmsConnector);
const MockedTextmagic = vi.mocked(TextmagicSmsConnector);
const MockedD7Networks = vi.mocked(D7NetworksSmsConnector);

const sendInput: SmsSendInput = {
  from: '+15555550100',
  to: '+15555550101',
  body: 'Hello from Thinwrap',
};

describe('Sms facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('instantiates VonageSmsConnector for "vonage"', () => {
    const config = { apiKey: 'key', apiSecret: 'secret', from: '+10000000000' };
    const facade = new Sms('vonage', config);

    expect(facade.id).toBe('vonage');
    expect(MockedVonage).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates TwilioSmsConnector for "twilio"', () => {
    const config = { accountSid: 'AC123', authToken: 'token', from: '+15555550100' };
    const facade = new Sms('twilio', config);

    expect(facade.id).toBe('twilio');
    expect(MockedTwilio).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates PlivoSmsConnector for "plivo"', () => {
    const config = { authId: 'id', authToken: 'token', from: '+15555550100' };
    const facade = new Sms('plivo', config);

    expect(facade.id).toBe('plivo');
    expect(MockedPlivo).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates SnsSmsConnector for "sns"', () => {
    const config = {
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    } satisfies SnsConfig;
    const facade = new Sms('sns', config);

    expect(facade.id).toBe('sns');
    expect(MockedSns).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates SinchSmsConnector for "sinch"', () => {
    const config = { servicePlanId: 'plan', apiToken: 'token', from: '+15555550100' };
    const facade = new Sms('sinch', config);

    expect(facade.id).toBe('sinch');
    expect(MockedSinch).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates TelnyxSmsConnector for "telnyx"', () => {
    const config = { apiKey: 'k', from: '+15555550100' };
    const facade = new Sms('telnyx', config);

    expect(facade.id).toBe('telnyx');
    expect(MockedTelnyx).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates InfobipSmsConnector for "infobip"', () => {
    const config = { apiKey: 'k', baseUrl: 'https://api.infobip.com', from: 'Acme' };
    const facade = new Sms('infobip', config);

    expect(facade.id).toBe('infobip');
    expect(MockedInfobip).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates MessageBirdSmsConnector for "messagebird"', () => {
    const config = { accessKey: 'k', from: 'Acme' };
    const facade = new Sms('messagebird', config);

    expect(facade.id).toBe('messagebird');
    expect(MockedMessageBird).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates TextmagicSmsConnector for "textmagic"', () => {
    const config = { username: 'u', apiKey: 'k', from: 'Acme' };
    const facade = new Sms('textmagic', config);

    expect(facade.id).toBe('textmagic');
    expect(MockedTextmagic).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates D7NetworksSmsConnector for "d7networks"', () => {
    const config = { apiToken: 'token', from: 'Acme' };
    const facade = new Sms('d7networks', config);

    expect(facade.id).toBe('d7networks');
    expect(MockedD7Networks).toHaveBeenCalledWith(config, undefined);
  });

  it('forwards `config.fetch` through to the connector constructor', () => {
    const customFetch = vi.fn() as unknown as typeof fetch;
    const config = { accountSid: 'AC', authToken: 't', from: '+15555550100', fetch: customFetch };
    new Sms('twilio', config);
    expect(MockedTwilio).toHaveBeenCalledWith(config, customFetch);
  });

  it('accepts a custom ISmsConnector instance', () => {
    const customConnector = {
      id: 'custom-sms',
      channelType: 'sms' as const,
      send: vi.fn().mockResolvedValue({
        success: true,
        status: 'sent',
        providerMessageId: 'msg-1',
        raw: {},
      }),
    };
    const facade = new Sms(customConnector as never);
    expect(facade.id).toBe('custom-sms');
  });

  it('forwards .send(input) to the connector', async () => {
    const result: SmsSendResult = {
      success: true,
      status: 'sent',
      providerMessageId: 'twilio-msg-1',
      raw: { sid: 'SM123' },
    };
    const sendMock = vi.fn().mockResolvedValue(result);
    MockedTwilio.prototype.send = sendMock;

    const facade = new Sms('twilio', {
      accountSid: 'AC',
      authToken: 't',
      from: '+15555550100',
    });
    const actual = await facade.send(sendInput);

    expect(sendMock).toHaveBeenCalledWith(sendInput);
    expect(actual).toEqual(result);
  });

  it('throws for unsupported provider id', () => {
    expect(() =>
      new Sms('unknown' as 'twilio', {
        accountSid: 'AC',
        authToken: 't',
        from: '+15555550100',
      }),
    ).toThrow('Unsupported SMS provider: unknown');
  });

  it('rejects mismatched config types at compile time', () => {
    const twilioCfg: TwilioConfig = {
      accountSid: 'AC',
      authToken: 't',
      from: '+15555550100',
    };
    // @ts-expect-error — twilio config (lacks apiKey/apiSecret) does not satisfy VonageConfig.
    new Sms('vonage', twilioCfg);
    expect(true).toBe(true);
  });
});
