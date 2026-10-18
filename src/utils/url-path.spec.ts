import { describe, it, expect, vi } from 'vitest';
import { ConnectorError } from '../types';
import { encodePathSegment } from './url-path';
import { SinchSmsConnector } from '../providers/sinch/sinch.connector';
import { PlivoSmsConnector } from '../providers/plivo/plivo.connector';
import { TelegramChatConnector } from '../providers/telegram/telegram.connector';
import { TwilioSmsConnector } from '../providers/twilio/twilio.connector';
import { WhatsAppChatConnector } from '../providers/whatsapp-business/whatsapp-business.connector';

// Config values that land in a URL path must stay ONE segment of the URL the
// credentials are sent to.
describe('encodePathSegment', () => {
  it('escapes /, ?, # and % so a value cannot add segments, a query or a fragment', () => {
    expect(encodePathSegment('plan/../../admin?x=1#f%', 'f')).toBe('plan%2F..%2F..%2Fadmin%3Fx%3D1%23f%25');
  });

  it('keeps RFC 3986 pchar ":" and "@" literal (Telegram tokens are "<id>:<secret>")', () => {
    expect(encodePathSegment('123456:AA-bb_CC', 'f')).toBe('123456:AA-bb_CC');
  });

  it.each(['', '.', '..', undefined])('rejects %j (dot-segments collapse, empty segments change the path)', (v) => {
    expect(() => encodePathSegment(v, 'X id')).toThrow(ConnectorError);
  });
});

function firstUrl(f: { mock: { calls: unknown[][] } }): unknown {
  return f.mock.calls[0]![0];
}

function ok(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('connectors path-escape their config values', () => {
  it('Sinch servicePlanId', async () => {
    const f = vi.fn(async () => ok({ id: 'b1' }));
    await new SinchSmsConnector({ servicePlanId: 'plan/x?y', apiToken: 't', from: '+1' }, f as unknown as typeof fetch)
      .send({ to: '+15550000000', body: 'hi' });
    expect(firstUrl(f)).toBe('https://us.sms.api.sinch.com/xms/v1/plan%2Fx%3Fy/batches');
  });

  it('Plivo authId (path only — the Basic-auth username is unchanged)', async () => {
    const f = vi.fn(async () => ok({ message_uuid: ['u'] }));
    await new PlivoSmsConnector({ authId: 'MA/1', authToken: 't', from: '+1' }, f as unknown as typeof fetch)
      .send({ to: '+15550000000', body: 'hi' });
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.plivo.com/v1/Account/MA%2F1/Message/');
    const auth = (init.headers as Record<string, string>).Authorization!;
    expect(Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString()).toBe('MA/1:t');
  });

  it('Telegram botToken keeps its ":"', async () => {
    const f = vi.fn(async () => ok({ ok: true, result: { message_id: 1 } }));
    await new TelegramChatConnector({ botToken: '123:abc' }, f as unknown as typeof fetch).send({ to: '1', body: 'x' });
    expect(firstUrl(f)).toBe('https://api.telegram.org/bot123:abc/sendMessage');
  });

  it('Twilio accountSid', async () => {
    const f = vi.fn(async () => ok({ sid: 'SM1' }));
    await new TwilioSmsConnector({ accountSid: 'AC1/..', authToken: 't', from: '+1' }, f as unknown as typeof fetch)
      .send({ to: '+15550000000', body: 'hi' });
    expect(firstUrl(f)).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1%2F../Messages.json');
  });

  it('WhatsApp phoneNumberId and graphApiVersion', async () => {
    const f = vi.fn(async () => ok({ messages: [{ id: 'w1' }] }));
    await new WhatsAppChatConnector(
      { accessToken: 't', phoneNumberId: '123/x', graphApiVersion: 'v21.0' },
      f as unknown as typeof fetch,
    ).send({ to: '15550000000', body: 'hi' });
    expect(firstUrl(f)).toBe('https://graph.facebook.com/v21.0/123%2Fx/messages');
  });

  it('an empty or dot-segment value is invalid_request before any request', async () => {
    const f = vi.fn();
    const err = await new SinchSmsConnector({ servicePlanId: '..', apiToken: 't', from: '+1' }, f as unknown as typeof fetch)
      .send({ to: '+15550000000', body: 'hi' })
      .catch((e: unknown) => e);
    expect((err as ConnectorError).providerCode).toBe('invalid_request');
    expect(f).not.toHaveBeenCalled();
  });
});
