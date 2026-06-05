import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Push } from './push.facade';
import { FcmPushConnector } from '../providers/fcm';
import { ExpoPushConnector } from '../providers/expo';
import { ApnsPushConnector } from '../providers/apns';
import { OneSignalPushConnector } from '../providers/one-signal';
import { PusherBeamsPushConnector } from '../providers/pusher-beams';
import { WonderPushPushConnector } from '../providers/wonderpush';
import type { PushSendInput, PushSendResult } from '../types';
import type { ApnsConfig } from '../providers/apns';

vi.mock('../providers/fcm');
vi.mock('../providers/expo');
vi.mock('../providers/apns');
vi.mock('../providers/one-signal');
vi.mock('../providers/pusher-beams');
vi.mock('../providers/wonderpush');

const MockedFcm = vi.mocked(FcmPushConnector);
const MockedExpo = vi.mocked(ExpoPushConnector);
const MockedApns = vi.mocked(ApnsPushConnector);
const MockedOneSignal = vi.mocked(OneSignalPushConnector);
const MockedPusherBeams = vi.mocked(PusherBeamsPushConnector);
const MockedWonderPush = vi.mocked(WonderPushPushConnector);

const sendInput: PushSendInput = {
  to: 'device-token-abc',
  title: 'Hello',
  body: 'World',
};

describe('Push facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('instantiates FcmPushConnector for "fcm"', () => {
    const config = { projectId: 'p', clientEmail: 'e@b.com', privateKey: 'k' };
    const facade = new Push('fcm', config);

    expect(facade.id).toBe('fcm');
    expect(MockedFcm).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates ExpoPushConnector for "expo"', () => {
    const config = { accessToken: 'tok' };
    const facade = new Push('expo', config);

    expect(facade.id).toBe('expo');
    expect(MockedExpo).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates ApnsPushConnector for "apns"', () => {
    const config: ApnsConfig = {
      privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
      keyId: 'KID',
      teamId: 'TID',
      bundleId: 'com.example.app',
      env: 'sandbox',
    };
    const facade = new Push('apns', config);

    expect(facade.id).toBe('apns');
    expect(MockedApns).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates OneSignalPushConnector for "one-signal"', () => {
    const config = { appId: 'a', apiKey: 'k' };
    const facade = new Push('one-signal', config);

    expect(facade.id).toBe('one-signal');
    expect(MockedOneSignal).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates PusherBeamsPushConnector for "pusher-beams"', () => {
    const config = { instanceId: 'i', secretKey: 's' };
    const facade = new Push('pusher-beams', config);

    expect(facade.id).toBe('pusher-beams');
    expect(MockedPusherBeams).toHaveBeenCalledWith(config, undefined);
  });

  it('instantiates WonderPushPushConnector for "wonderpush"', () => {
    const config = { accessToken: 't' };
    const facade = new Push('wonderpush', config);

    expect(facade.id).toBe('wonderpush');
    expect(MockedWonderPush).toHaveBeenCalledWith(config, undefined);
  });

  it('forwards `config.fetch` through to the connector constructor', () => {
    const customFetch = vi.fn() as unknown as typeof fetch;
    const config = { projectId: 'p', clientEmail: 'e@b.com', privateKey: 'k', fetch: customFetch };
    new Push('fcm', config);
    expect(MockedFcm).toHaveBeenCalledWith(config, customFetch);
  });

  it('accepts a custom IPushConnector instance', () => {
    const customConnector = {
      id: 'custom-push',
      channelType: 'push' as const,
      send: vi.fn().mockResolvedValue({
        success: true,
        status: 'sent',
        providerMessageId: 'msg-1',
        raw: {},
      }),
    };
    const facade = new Push(customConnector as never);
    expect(facade.id).toBe('custom-push');
  });

  it('forwards .send(input) to the connector', async () => {
    const result: PushSendResult = {
      success: true,
      status: 'sent',
      providerMessageId: 'projects/p/messages/abc',
      raw: { name: 'projects/p/messages/abc' },
    };
    const sendMock = vi.fn().mockResolvedValue(result);
    MockedFcm.prototype.send = sendMock;

    const facade = new Push('fcm', { projectId: 'p', clientEmail: 'e@b.com', privateKey: 'k' });
    const actual = await facade.send(sendInput);

    expect(sendMock).toHaveBeenCalledWith(sendInput);
    expect(actual).toEqual(result);
  });

  it('throws for unsupported provider id', () => {
    expect(() =>
      new Push('unknown' as 'fcm', { projectId: 'p', clientEmail: 'e@b.com', privateKey: 'k' }),
    ).toThrow('Unsupported push provider: unknown');
  });

  it('rejects mismatched config types at compile time', () => {
    const apnsCfg: ApnsConfig = {
      privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
      keyId: 'KID',
      teamId: 'TID',
      bundleId: 'com.example.app',
      env: 'sandbox',
    };
    // @ts-expect-error — apns config (lacks projectId/clientEmail/privateKey shape) does not satisfy FcmConfig.
    new Push('fcm', apnsCfg);
    expect(true).toBe(true);
  });
});
