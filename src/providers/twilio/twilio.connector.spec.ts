import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { TwilioSmsConnector, twilioApiHost } from './twilio.connector';
import type { TwilioConfig } from './twilio.config';
import { ChannelTypeEnum } from '../../types';
import { ConnectorError } from '../../utils';
import { createRetryAfterFixture } from '../../test-utils';

const mockFetch = vi.fn();

beforeAll(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: TwilioConfig = {
  accountSid: 'ACtest123',
  authToken: 'auth-token-secret',
  from: '+15551234567',
};

function successResponse(overrides: Partial<{ sid: string; status: string }> = {}): Response {
  return new Response(
    JSON.stringify({
      sid: overrides.sid ?? 'SMtest456',
      status: overrides.status ?? 'queued',
      to: '+14155550100',
      from: '+15551234567',
      body: 'Hello!',
      date_created: 'Thu, 30 Jul 2025 20:12:31 +0000',
    }),
    { status: 200 },
  );
}

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('TwilioSmsConnector', () => {
  let connector: TwilioSmsConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new TwilioSmsConnector(defaultConfig);
  });

  // ===========================================================================
  // Thinwrap-native `.send()` surface
  // ===========================================================================

  describe('.send() — Thinwrap-native surface', () => {
    it('2xx happy path (region unset): POSTs form-encoded body with Basic auth to canonical us1 URL', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.send({
        to: '+14155550100',
        body: 'Hello from Twilio!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(
        'https://api.twilio.com/2010-04-01/Accounts/ACtest123/Messages.json',
      );

      const expectedAuth = Buffer.from('ACtest123:auth-token-secret').toString('base64');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${expectedAuth}`,
        }),
      );

      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('To')).toBe('+14155550100');
      expect(params.get('From')).toBe('+15551234567');
      expect(params.get('Body')).toBe('Hello from Twilio!');

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: 'SMtest456',
        raw: expect.objectContaining({ sid: 'SMtest456' }),
      });
    });

    // Twilio understanding-edge-locations: non-US hosts are
    // "PRODUCT.EDGE_LOCATION.PROCESSING_REGION.twilio.com" and "The edge location
    // name (dublin, sydney) is a required part of the hostname for non-US regions".
    it('region: "ie1" routes to api.dublin.ie1.twilio.com (legacy api.ie1 host is dead)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const ieConnector = new TwilioSmsConnector({ ...defaultConfig, region: 'ie1' });

      await ieConnector.send({ to: '+14155550100', body: 'Hi' });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/ACtest123/Messages.json',
      );
    });

    it('region: "au1" routes to api.sydney.au1.twilio.com', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const auConnector = new TwilioSmsConnector({ ...defaultConfig, region: 'au1' });

      await auConnector.send({ to: '+14155550100', body: 'Hi' });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://api.sydney.au1.twilio.com/2010-04-01/Accounts/ACtest123/Messages.json',
      );
    });

    it('edge overrides the region default edge: ie1 + frankfurt → api.frankfurt.ie1.twilio.com', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const c = new TwilioSmsConnector({ ...defaultConfig, region: 'ie1', edge: 'frankfurt' });

      await c.send({ to: '+14155550100', body: 'Hi' });

      expect(mockFetch.mock.calls[0]![0]).toBe(
        'https://api.frankfurt.ie1.twilio.com/2010-04-01/Accounts/ACtest123/Messages.json',
      );
    });

    it('edge without region pins the us1 edge: api.{edge}.us1.twilio.com', () => {
      expect(twilioApiHost(undefined, 'ashburn')).toBe('api.ashburn.us1.twilio.com');
      expect(twilioApiHost('us1', 'tokyo')).toBe('api.tokyo.us1.twilio.com');
      expect(twilioApiHost('us1', undefined)).toBe('api.twilio.com');
    });

    // Twilio legacy-regions: br1/de1/jp1/sg1/us2 "process in US1 — use
    // api.twilio.com"; their api.<region>.twilio.com hosts stopped resolving.
    it.each(['us2', 'br1', 'de1', 'jp1', 'sg1', 'xx', 'undefined'])(
      'region %s → ConnectorError(invalid_request) before any credentialed request',
      async (region) => {
        const c = new TwilioSmsConnector({
          ...defaultConfig,
          region: region as unknown as TwilioConfig['region'],
        });
        const err = await c.send({ to: '+14155550100', body: 'Hi' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).providerCode).toBe('invalid_request');
        expect(mockFetch).not.toHaveBeenCalled();

        const err2 = await c.sendMessage({ to: '+14155550100', content: 'Hi' }).catch((e: unknown) => e);
        expect((err2 as ConnectorError).providerCode).toBe('invalid_request');
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

    it('edge outside Twilio\'s public edge list → invalid_request (it is interpolated into the host)', async () => {
      const c = new TwilioSmsConnector({
        ...defaultConfig,
        region: 'ie1',
        edge: 'evil.example.com/x' as unknown as TwilioConfig['edge'],
      });
      const err = await c.send({ to: '+14155550100', body: 'Hi' }).catch((e: unknown) => e);
      expect((err as ConnectorError).providerCode).toBe('invalid_request');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('maps 400 with body.code 21211 → invalid_recipient', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(400, { code: 21211, message: "Invalid 'To' Phone Number" }),
      );

      try {
        await connector.send({ to: '+1invalid', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.statusCode).toBe(400);
        expect(e.providerCode).toBe('invalid_recipient');
        expect(e.providerMessage).toBe("Invalid 'To' Phone Number");
      }
    });

    it('maps 401 → auth_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(401, { code: 20003, message: 'Authentication Error' }),
      );

      try {
        await connector.send({ to: '+14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(401);
        expect(e.providerCode).toBe('auth_failed');
      }
    });

    it('maps 429 with Retry-After: 60 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '60',
          errorBody: { code: 20429, message: 'Too Many Requests' },
        }),
      );

      try {
        await connector.send({ to: '+14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.providerCode).toBe('rate_limited');
        expect(e.providerMessage).toBe('Too Many Requests');
        expect(e.cause as Record<string, unknown>).toMatchObject({
          retryAfter: '60',
          retryAfterSeconds: 60,
        });
      }
    });

    it('maps 500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(500, { message: 'Internal Server Error' }),
      );

      try {
        await connector.send({ to: '+14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e.statusCode).toBe(500);
        expect(e.providerCode).toBe('provider_unavailable');
      }
    });

    it('_passthrough body + headers honored (Custom field appears in form body; X-Idempotency-Key in headers)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+14155550100',
        body: 'Hello',
        _passthrough: {
          body: { Custom: 'x' },
          headers: { 'X-Idempotency-Key': 'k1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('Custom')).toBe('x');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'X-Idempotency-Key': 'k1' }),
      );
    });

    it('mediaUrl[] is multi-value form-encoded as repeated MediaUrl= fields', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+14155550100',
        body: 'MMS',
        mediaUrl: ['https://a.png', 'https://b.png'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      const mediaUrls = params.getAll('MediaUrl');
      expect(mediaUrls).toEqual(['https://a.png', 'https://b.png']);
    });

    it('messagingServiceSid is accepted as alternative to from (no From field on the wire)', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const noFromConnector = new TwilioSmsConnector({
        accountSid: 'ACtest123',
        authToken: 'auth-token-secret',
      });

      await noFromConnector.send({
        to: '+14155550100',
        body: 'Hi',
        messagingServiceSid: 'MGabcdef',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('From')).toBeNull();
      expect(params.get('MessagingServiceSid')).toBe('MGabcdef');
    });

    it('throws invalid_request when neither from nor messagingServiceSid is available', async () => {
      const noFromConnector = new TwilioSmsConnector({
        accountSid: 'ACtest123',
        authToken: 'auth-token-secret',
      });

      try {
        await noFromConnector.send({ to: '+14155550100', body: 'Hi' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('invalid_request');
        expect(e.statusCode).toBe(400);
      }
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('serializes Twilio-narrowed fields (statusCallback, maxPrice, validityPeriod, contentSid, etc.) as PascalCase form keys', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+14155550100',
        body: 'Hi',
        statusCallback: 'https://example.com/cb',
        applicationSid: 'APabc',
        maxPrice: '0.05',
        provideFeedback: true,
        validityPeriod: 14400,
        forceDelivery: false,
        contentRetention: 'discard',
        addressRetention: 'obfuscate',
        smartEncoded: true,
        persistentAction: ['geo:37.7749,-122.4194'],
        shortenUrls: true,
        scheduleType: 'fixed',
        sendAt: '2026-06-01T00:00:00Z',
        sendAsMms: false,
        contentVariables: '{"1":"x"}',
        riskCheck: 'enable',
        contentSid: 'HXabc',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('StatusCallback')).toBe('https://example.com/cb');
      expect(params.get('ApplicationSid')).toBe('APabc');
      expect(params.get('MaxPrice')).toBe('0.05');
      expect(params.get('ProvideFeedback')).toBe('true');
      expect(params.get('ValidityPeriod')).toBe('14400');
      expect(params.get('ForceDelivery')).toBe('false');
      expect(params.get('ContentRetention')).toBe('discard');
      expect(params.get('AddressRetention')).toBe('obfuscate');
      expect(params.get('SmartEncoded')).toBe('true');
      expect(params.getAll('PersistentAction')).toEqual(['geo:37.7749,-122.4194']);
      expect(params.get('ShortenUrls')).toBe('true');
      expect(params.get('ScheduleType')).toBe('fixed');
      expect(params.get('SendAt')).toBe('2026-06-01T00:00:00Z');
      expect(params.get('SendAsMms')).toBe('false');
      expect(params.get('ContentVariables')).toBe('{"1":"x"}');
      expect(params.get('RiskCheck')).toBe('enable');
      expect(params.get('ContentSid')).toBe('HXabc');
    });

    it(' explicit PascalCase transform: camelCase _passthrough.body keys are rewritten to PascalCase on the wire', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.send({
        to: '+14155550100',
        body: 'Hi',
        _passthrough: {
          body: { customField: 'v', anotherKey: 'w' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('CustomField')).toBe('v');
      expect(params.get('AnotherKey')).toBe('w');
    });

    it('wraps fetch network errors as ConnectorError with provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      try {
        await connector.send({ to: '+14155550100', body: 'x' });
        expect.unreachable();
      } catch (err) {
        const e = err as ConnectorError;
        expect(e).toBeInstanceOf(ConnectorError);
        expect(e.providerCode).toBe('provider_unavailable');
        expect(e.statusCode).toBeNull();
      }
    });
  });

  // ===========================================================================
  // Novu-compatible `sendMessage()` surface
  // ===========================================================================

  describe('.sendMessage() — preserved Novu surface', () => {
    it('should have id "twilio" and channelType SMS', () => {
      expect(connector.id).toBe('twilio');
      expect(connector.channelType).toBe(ChannelTypeEnum.SMS);
    });

    it('routes to the same region/edge host as .send()', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());
      const c = new TwilioSmsConnector({ ...defaultConfig, region: 'ie1' });
      await c.sendMessage({ to: '+14155550100', content: 'Hi' });
      expect(mockFetch.mock.calls[0]![0]).toBe(
        'https://api.dublin.ie1.twilio.com/2010-04-01/Accounts/ACtest123/Messages.json',
      );
    });

    it('should send form-encoded message with Basic auth to correct URL', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      const result = await connector.sendMessage({
        to: '+14155550100',
        content: 'Hello from Twilio!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(
        'https://api.twilio.com/2010-04-01/Accounts/ACtest123/Messages.json',
      );

      const expectedAuth = Buffer.from('ACtest123:auth-token-secret').toString('base64');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${expectedAuth}`,
        }),
      );

      const params = new URLSearchParams(reqInit.body as string);
      expect(params.get('To')).toBe('+14155550100');
      expect(params.get('From')).toBe('+15551234567');
      expect(params.get('Body')).toBe('Hello from Twilio!');

      expect(result).toEqual({ id: 'SMtest456', date: expect.any(String) });
    });

    it('should use "from" in options when it overrides the config default', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage({
        to: '+14155550100',
        content: 'Hello!',
        from: '+18005550199',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('From')).toBe('+18005550199');
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(successResponse());

      await connector.sendMessage(
        { to: '+14155550100', content: 'Hello!' },
        {
          _passthrough: {
            body: { StatusCallback: 'https://example.com/callback' },
          },
        },
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const params = new URLSearchParams((init as RequestInit).body as string);
      expect(params.get('StatusCallback')).toBe('https://example.com/callback');
      expect(params.get('To')).toBe('+14155550100');
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 20003, message: 'Authentication Error' }),
          { status: 401 },
        ),
      );

      try {
        await connector.sendMessage({
          to: '+14155550100',
          content: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(401);
        // Same classification path as send(): mapTwilioErrorToProviderCode
        expect(connectorErr.providerCode).toBe('auth_failed');
        expect(connectorErr.providerMessage).toBe('Authentication Error');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({
          to: '+14155550100',
          content: 'Hello!',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toBe('Network error');
        expect((err as ConnectorError).statusCode).toBeNull();
        expect((err as ConnectorError).providerCode).toBe('provider_unavailable');
      }
    });
  });
});
