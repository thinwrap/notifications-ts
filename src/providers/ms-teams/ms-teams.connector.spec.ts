import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MsTeamsChatConnector } from './ms-teams.connector';
import type { MsTeamsConfig } from './ms-teams.config';
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

const defaultConfig: MsTeamsConfig = {
  webhookUrl:
    'https://region.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?key=123',
};

function okTextResponse() {
  return new Response('1', { status: 200 });
}

describe('MsTeamsChatConnector', () => {
  let connector: MsTeamsChatConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new MsTeamsChatConnector(defaultConfig);
  });

  it('should have id "ms-teams" and channelType CHAT', () => {
    expect(connector.id).toBe('ms-teams');
    expect(connector.channelType).toBe(ChannelTypeEnum.CHAT);
  });

  // ---------------------------------------------------------------------------
  // Novu-compatible `sendMessage()` surface
  // ---------------------------------------------------------------------------

  describe('sendMessage (brownfield Novu-shaped surface)', () => {
    it('should send an Adaptive Card message and return { id: undefined, date }', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      const result = await connector.sendMessage({
        content: 'Hello from Teams!',
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(defaultConfig.webhookUrl);
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );

      const body = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(body.type).toBe('message');
      const attachments = body.attachments as Array<Record<string, unknown>>;
      expect(attachments).toHaveLength(1);
      expect(attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');

      const card = attachments[0]!.content as Record<string, unknown>;
      expect(card.type).toBe('AdaptiveCard');
      const cardBody = card.body as Array<Record<string, unknown>>;
      expect(cardBody[0]!.text).toBe('Hello from Teams!');

      expect(result).toEqual({ id: undefined, date: expect.any(String) });
    });

    it('should use options.webhookUrl over config.webhookUrl', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.sendMessage({
        content: 'Hello!',
        webhookUrl: 'https://other.logic.azure.com/workflows/xyz',
      });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://other.logic.azure.com/workflows/xyz');
    });

    it('should merge bridgeProviderData passthrough body', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.sendMessage(
        { content: 'Hello!' },
        { _passthrough: { body: { summary: 'Alert notification' } } }
      );

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      expect(body.summary).toBe('Alert notification');
    });

    it('should throw ConnectorError when no webhook URL is provided', async () => {
      const noUrlConnector = new MsTeamsChatConnector({});

      try {
        await noUrlConnector.sendMessage({ content: 'Hello!' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(400);
        expect(connectorErr.message).toContain('Missing webhook URL');
      }
    });

    it('should throw ConnectorError on API error', async () => {
      mockFetch.mockResolvedValueOnce(new Response('InvalidPayload', { status: 400 }));

      try {
        await connector.sendMessage({ content: 'Hello!' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const connectorErr = err as ConnectorError;
        expect(connectorErr.statusCode).toBe(400);
        // Same classification path as send(): mapVendorError
        expect(connectorErr.providerCode).toBe('invalid_request');
        expect(connectorErr.providerMessage).toBe('InvalidPayload');
      }
    });

    it('should throw ConnectorError for network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await connector.sendMessage({ content: 'Hello!' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        expect((err as ConnectorError).message).toBe('Network error');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Thinwrap-native send() surface.
  // ---------------------------------------------------------------------------

  describe('send() — Thinwrap-native IChatConnector surface', () => {
    it('happy path: synthesizes default AdaptiveCard from body and returns raw "1"', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      const result = await connector.send({ body: 'Hello from Teams!' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;

      expect(url).toBe(defaultConfig.webhookUrl);
      expect(reqInit.method).toBe('POST');
      expect(reqInit.headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );

      const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;
      expect(wireBody.type).toBe('message');
      const attachments = wireBody.attachments as Array<Record<string, unknown>>;
      expect(attachments).toHaveLength(1);
      expect(attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');

      const card = attachments[0]!.content as Record<string, unknown>;
      expect(card.type).toBe('AdaptiveCard');
      expect(card.version).toBe('1.4');
      const cardBody = card.body as Array<Record<string, unknown>>;
      expect(cardBody[0]).toMatchObject({ type: 'TextBlock', text: 'Hello from Teams!' });

      expect(result).toEqual({
        success: true,
        status: 'sent',
        providerMessageId: null,
        raw: '1',
      });
    });

    it('card narrowed input replaces synthesized card; body is NOT auto-inserted as TextBlock', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.send({
        body: 'ignored-when-card-set',
        card: {
          type: 'AdaptiveCard',
          version: '1.5',
          body: [{ type: 'TextBlock', text: 'custom', size: 'Large' }],
          actions: [{ type: 'Action.OpenUrl', title: 'Go', url: 'https://x' }],
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const wireBody = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
      const attachments = wireBody.attachments as Array<Record<string, unknown>>;
      const card = attachments[0]!.content as Record<string, unknown>;

      expect(card).toEqual({
        type: 'AdaptiveCard',
        version: '1.5',
        body: [{ type: 'TextBlock', text: 'custom', size: 'Large' }],
        actions: [{ type: 'Action.OpenUrl', title: 'Go', url: 'https://x' }],
      });

      // The body is NOT auto-inserted into the supplied card — verify only one
      // TextBlock with the supplied text.
      const cardBody = card.body as Array<Record<string, unknown>>;
      expect(cardBody).toHaveLength(1);
      expect(cardBody[0]!.text).toBe('custom');
    });

    it('400 + "Invalid webhook URL" body → auth_failed (Teams-specific quirk)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Invalid webhook URL or HTTP method.', { status: 400 })
      );

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('auth_failed');
        expect(ce.statusCode).toBe(400);
        expect(ce.providerMessage).toBe('Invalid webhook URL or HTTP method.');
      }
    });

    it('400 (other body) → invalid_request', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
      }
    });

    it('401 / 403 / 404 → auth_failed', async () => {
      for (const status of [401, 403, 404]) {
        mockFetch.mockResolvedValueOnce(new Response('nope', { status }));
        try {
          await connector.send({ body: 'hi' });
          expect.unreachable('Should have thrown');
        } catch (err) {
          expect((err as ConnectorError).providerCode).toBe('auth_failed');
        }
      }
    });

    it('500 → provider_unavailable', async () => {
      mockFetch.mockResolvedValueOnce(new Response('server error', { status: 500 }));

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ConnectorError).providerCode).toBe('provider_unavailable');
      }
    });

    it('sendMessage(): a 200 with a masked error body is an error too, like .send()', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Microsoft Teams endpoint returned HTTP error 429 with ContextId abc.', { status: 200 }),
      );
      const err = await connector.sendMessage({ content: 'hi' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).providerCode).toBe('rate_limited');
    });

    it('HTTP 200 with a masked error body (throttling) → error, not success', async () => {
      // Teams returns 200 with an error string when throttled; the embedded
      // HTTP code drives the taxonomy (429 → rate_limited).
      mockFetch.mockResolvedValueOnce(
        new Response(
          'Microsoft Teams endpoint returned HTTP error 429 with ContextId abc.',
          { status: 200 },
        ),
      );

      try {
        await connector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as ConnectorError).providerCode).toBe('rate_limited');
      }
    });

    describe('2xx success detection (Workflows vs legacy connector webhooks)', () => {
      const legacyUrl = 'https://contoso.webhook.office.com/webhookb2/abc@def/IncomingWebhook/123/456';
      const powerPlatformUrl =
        'https://default123.45.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=xyz';

      it('202 with an empty body (Logic Apps Request trigger, no Response action) → success', async () => {
        mockFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));

        const result = await connector.send({ body: 'hi' });

        expect(result).toMatchObject({ success: true, status: 'sent', providerMessageId: null });
      });

      it('202 from a legacy connector host with a non-"1" body → still success', async () => {
        mockFetch.mockResolvedValueOnce(new Response('', { status: 202 }));
        const legacy = new MsTeamsChatConnector({ webhookUrl: legacyUrl });

        await expect(legacy.send({ body: 'hi' })).resolves.toMatchObject({ success: true });
      });

      it('200 "1" from a legacy connector host → success', async () => {
        mockFetch.mockResolvedValueOnce(new Response('1', { status: 200 }));
        const legacy = new MsTeamsChatConnector({ webhookUrl: legacyUrl });

        const result = await legacy.send({ body: 'hi' });

        expect(result).toMatchObject({ success: true, raw: '1' });
      });

      it('200 "1" from outlook.office.com → success', async () => {
        mockFetch.mockResolvedValueOnce(new Response('1', { status: 200 }));
        const legacy = new MsTeamsChatConnector({
          webhookUrl: 'https://outlook.office.com/webhook/abc@def/IncomingWebhook/123/456',
        });

        await expect(legacy.send({ body: 'hi' })).resolves.toMatchObject({ success: true });
      });

      it('200 from a legacy connector host with some other text → failure (502, provider_unavailable)', async () => {
        mockFetch.mockResolvedValueOnce(
          new Response('Summary or Text is required.', { status: 200 }),
        );
        const legacy = new MsTeamsChatConnector({ webhookUrl: legacyUrl });

        await expect(legacy.send({ body: 'hi' })).rejects.toMatchObject({
          statusCode: 502,
          providerCode: 'provider_unavailable',
        });
      });

      it('200 with "HTTP error 413" embedded → failure mapped from 413', async () => {
        mockFetch.mockResolvedValueOnce(
          new Response(
            'Webhook message delivery failed with error: Microsoft Teams endpoint returned HTTP error 413 with ContextId tcid=0.',
            { status: 200 },
          ),
        );
        const legacy = new MsTeamsChatConnector({ webhookUrl: legacyUrl });

        await expect(legacy.send({ body: 'hi' })).rejects.toMatchObject({ statusCode: 413 });
      });

      it('200 with an empty body from a logic.azure.com Workflows URL → success', async () => {
        mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

        await expect(connector.send({ body: 'hi' })).resolves.toMatchObject({
          success: true,
          raw: '',
        });
      });

      it('200 with an empty body from a powerplatform.com Workflows URL → success', async () => {
        mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));
        const workflows = new MsTeamsChatConnector({ webhookUrl: powerPlatformUrl });

        await expect(workflows.send({ body: 'hi' })).resolves.toMatchObject({ success: true });
      });
    });

    it('429 + Retry-After: 30 → rate_limited with cause.retryAfter + cause.retryAfterSeconds', async () => {
      mockFetch.mockResolvedValueOnce(
        createRetryAfterFixture({
          status: 429,
          retryAfter: '30',
          errorBody: 'rate_limited',
          contentType: 'text/plain',
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
          retryAfter: '30',
          retryAfterSeconds: 30,
        });
      }
    });

    it('_passthrough body merges into the envelope via deep-merge', async () => {
      mockFetch.mockResolvedValueOnce(okTextResponse());

      await connector.send({
        body: 'hi',
        _passthrough: {
          body: { summary: 'Alert notification' },
          headers: { 'X-Trace-Id': 't-1' },
        },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const reqInit = init as RequestInit;
      const wireBody = JSON.parse(reqInit.body as string) as Record<string, unknown>;

      // _passthrough.body.summary merges at the top level alongside the synthesized envelope.
      expect(wireBody.summary).toBe('Alert notification');
      expect(wireBody.type).toBe('message');
      expect(wireBody.attachments).toBeDefined();

      expect(reqInit.headers).toEqual(
        expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Trace-Id': 't-1',
        })
      );

      // Compile-time contract: `to` is NOT a field on MsTeamsNarrowedInput.
      // @ts-expect-error - 'to' is omitted from MsTeamsNarrowedInput (webhook URL targets the channel).
      void (async () => connector.send({ to: 'x', body: 'y' }));
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

    it('missing config.webhookUrl → ConnectorError invalid_request', async () => {
      const noUrlConnector = new MsTeamsChatConnector({});

      try {
        await noUrlConnector.send({ body: 'hi' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectorError);
        const ce = err as ConnectorError;
        expect(ce.providerCode).toBe('invalid_request');
        expect(ce.statusCode).toBe(400);
      }
    });
  });
});
