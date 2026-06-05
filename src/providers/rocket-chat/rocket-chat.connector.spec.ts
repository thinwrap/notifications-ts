import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { RocketChatChatConnector } from './rocket-chat.connector';
import type { RocketChatConfig } from './rocket-chat.config';
import { ConnectorError } from '../../utils';
import { createRetryAfterFixture } from '../../test-utils';

const mockFetch = vi.fn();

beforeAll(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const defaultConfig: RocketChatConfig = {
  webhookUrl: 'https://rocketchat.example.com/hooks/integration-id/token',
};

function successResponse() {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RocketChatChatConnector', () => {
  let connector: RocketChatChatConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new RocketChatChatConnector(defaultConfig);
  });

  it('has id "rocket-chat"', () => {
    expect(connector.id).toBe('rocket-chat');
  });

  // ---------------------------------------------------------------------------
  // Thinwrap-native send() surface ACs 9.
  // ---------------------------------------------------------------------------

  it('2xx happy path: returns success with providerMessageId === null and raw JSON', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    const result = await connector.send({ body: 'Hello from Rocket.Chat!' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    const reqInit = init as RequestInit;

    expect(url).toBe('https://rocketchat.example.com/hooks/integration-id/token');
    expect(reqInit.method).toBe('POST');
    expect(reqInit.headers).toEqual(
      expect.objectContaining({ 'Content-Type': 'application/json' }),
    );

    const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;
    expect(wireBody.text).toBe('Hello from Rocket.Chat!');

    expect(result).toEqual({
      success: true,
      status: 'sent',
      providerMessageId: null,
      raw: { success: true },
    });
  });

  it('maps all narrowed top-level fields verbatim to the wire (Rocket.Chat-native names)', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await connector.send({
      body: 'hi',
      alias: 'alertbot',
      avatar: 'https://a.png',
      emoji: ':robot_face:',
      // base ChatSendInput `to` → wire `channel`.
      to: '#alerts',
      tmid: 'message-id-123',
      tshow: true,
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const wireBody = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >;

    expect(wireBody.text).toBe('hi');
    expect(wireBody.alias).toBe('alertbot');
    expect(wireBody.avatar).toBe('https://a.png');
    expect(wireBody.emoji).toBe(':robot_face:');
    expect(wireBody.channel).toBe('#alerts');
    expect(wireBody.tmid).toBe('message-id-123');
    expect(wireBody.tshow).toBe(true);
  });

  it('maps Slack-compat attachment fields camelCase → snake_case', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await connector.send({
      body: 'incident',
      attachments: [
        {
          color: 'good',
          authorName: 'Alice',
          authorLink: 'https://a',
          authorIcon: 'https://i',
          title: 'Issue',
          titleLink: 'https://t',
          imageUrl: 'https://im',
          thumbUrl: 'https://th',
          fields: [{ title: 'sev', value: 'p1', short: true }],
        },
      ],
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const wireBody = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >;

    const wireAttachments = wireBody.attachments as Array<Record<string, unknown>>;
    expect(wireAttachments).toHaveLength(1);
    const att = wireAttachments[0]!;

    // snake_case keys present.
    expect(att.author_name).toBe('Alice');
    expect(att.author_link).toBe('https://a');
    expect(att.author_icon).toBe('https://i');
    expect(att.title_link).toBe('https://t');
    expect(att.image_url).toBe('https://im');
    expect(att.thumb_url).toBe('https://th');

    // Same-form keys passed through untouched.
    expect(att.color).toBe('good');
    expect(att.title).toBe('Issue');
    expect(att.fields).toEqual([{ title: 'sev', value: 'p1', short: true }]);

    // camelCase keys MUST NOT be on the wire.
    expect(att.authorName).toBeUndefined();
    expect(att.authorLink).toBeUndefined();
    expect(att.authorIcon).toBeUndefined();
    expect(att.titleLink).toBeUndefined();
    expect(att.imageUrl).toBeUndefined();
    expect(att.thumbUrl).toBeUndefined();
  });

  it('401 → auth_failed', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    try {
      await connector.send({ body: 'hi' });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      const ce = err as ConnectorError;
      expect(ce.providerCode).toBe('auth_failed');
      expect(ce.statusCode).toBe(401);
      expect(ce.providerMessage).toBe('invalid token');
    }
  });

  it('429 + Retry-After: 5 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
    mockFetch.mockResolvedValueOnce(
      createRetryAfterFixture({
        status: 429,
        retryAfter: '5',
        errorBody: { success: false, error: 'rate_limited' },
      }),
    );

    try {
      await connector.send({ body: 'hi' });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      const ce = err as ConnectorError;
      expect(ce.providerCode).toBe('rate_limited');
      expect(ce.statusCode).toBe(429);
      expect(ce.providerMessage).toBe('rate_limited');
      expect(ce.cause).toMatchObject({
        retryAfter: '5',
        retryAfterSeconds: 5,
      });
    }
  });

  it('_passthrough merges parseUrls: false into the connector body; `to` is preserved while brownfield REST-auth config fields are compile-time errors', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await connector.send({
      body: 'hi',
      attachments: [{ color: 'good', text: 'attached' }],
      _passthrough: {
        // Rocket.Chat option to disable URL preview generation server-side.
        body: { parseUrls: false },
        headers: { 'X-Trace-Id': 't-1' },
      },
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const reqInit = init as RequestInit;
    const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;

    expect(wireBody.text).toBe('hi');
    expect(wireBody.parseUrls).toBe(false);
    expect(wireBody.attachments).toEqual([{ color: 'good', text: 'attached' }]);

    expect(reqInit.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Trace-Id': 't-1',
      }),
    );

    // Compile-time contract: `to` IS preserved on RocketChatNarrowedInput
    // as the optional channel override; the connector
    // translates it to the wire `channel` field. So this must type-check.
    void (async () => connector.send({ to: 'x', body: 'y' }));

    // Compile-time contract: the brownfield REST-auth config fields no longer
    // exist on RocketChatConfig (breaking change this is the first public release with no prior consumers).
    // @ts-expect-error - 'serverUrl' is not a field on RocketChatConfig (was brownfield REST-API auth).
    void ({ webhookUrl: 'x', serverUrl: 'y' } satisfies RocketChatConfig);
    // @ts-expect-error - 'authToken' is not a field on RocketChatConfig (was brownfield REST-API auth).
    void ({ webhookUrl: 'x', authToken: 'y' } satisfies RocketChatConfig);
    // @ts-expect-error - 'userId' is not a field on RocketChatConfig (was brownfield REST-API auth).
    void ({ webhookUrl: 'x', userId: 'y' } satisfies RocketChatConfig);
    // @ts-expect-error - 'roomId' is not a field on RocketChatConfig (was brownfield REST-API auth).
    void ({ webhookUrl: 'x', roomId: 'y' } satisfies RocketChatConfig);
  });

  it('network error → ConnectorError with provider_unavailable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket hang up'));

    try {
      await connector.send({ body: 'hi' });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      const ce = err as ConnectorError;
      expect(ce.providerCode).toBe('provider_unavailable');
      expect(ce.statusCode).toBeNull();
    }
  });
});
