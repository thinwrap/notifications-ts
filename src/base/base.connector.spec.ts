import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramChatConnector } from '../providers/telegram/telegram.connector';
import { ConnectorError } from '../types';

/**
 * The transport seam every connector shares.
 *
 * Exercised through a real connector rather than a synthetic subclass, because
 * the guarantees under test must hold for the 34 connectors that call
 * `this.fetchImpl` directly with their own catch block — not just for the ones
 * routed through `sendPostJson`. Telegram is the sharpest case: its credential
 * lives in the URL *path* (`/bot<token>/sendMessage`).
 */
const BOT_TOKEN = '123456:AAHsecret-bot-token';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function connector() {
  return new TelegramChatConnector({ botToken: BOT_TOKEN });
}

function send() {
  return connector().send({ to: '42', body: 'hi' });
}

/**
 * Shape of undici's `ResponseError`, thrown when the host application installs a
 * global dispatcher composing `interceptors.responseError()`. Duck-typed exactly
 * as the library duck-types it — no undici import.
 */
function responseErrorRejection(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const wrapper = new TypeError('fetch failed');
  (wrapper as { cause?: unknown }).cause = {
    name: 'ResponseError',
    code: 'UND_ERR_RESPONSE',
    statusCode,
    body,
    headers: { 'content-type': 'application/json', ...headers },
  };
  return wrapper;
}

describe('BaseConnector transport seam', () => {
  describe('a fetch that rejects instead of returning a non-2xx', () => {
    it('maps the real status through the connector rather than provider_unavailable', async () => {
      mockFetch.mockRejectedValueOnce(
        responseErrorRejection(401, { ok: false, description: 'Unauthorized' }),
      );
      const err = (await send().catch((e) => e)) as ConnectorError;
      expect(err).toBeInstanceOf(ConnectorError);
      expect(err.statusCode).toBe(401);
      expect(err.providerCode).toBe('auth_failed');
    });

    it('carries the rebuilt body into the connector, so retry hints survive', async () => {
      // Telegram is the retry outlier: it reports `parameters.retry_after` in the
      // JSON body rather than a Retry-After header. That the value arrives at all
      // proves the rebuilt Response's body reaches the connector's mapping.
      mockFetch.mockRejectedValueOnce(
        responseErrorRejection(429, {
          ok: false,
          description: 'Too Many Requests',
          parameters: { retry_after: 30 },
        }),
      );
      const err = (await send().catch((e) => e)) as ConnectorError;
      expect(err.statusCode).toBe(429);
      expect(err.providerCode).toBe('rate_limited');
      expect((err.cause as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(30);
    });

    it('surfaces the provider message the interceptor buffered', async () => {
      mockFetch.mockRejectedValueOnce(
        responseErrorRejection(400, { ok: false, description: 'chat not found' }),
      );
      const err = (await send().catch((e) => e)) as ConnectorError;
      expect(err.providerMessage).toContain('chat not found');
    });

    it('recovers status and headers when retry exhaustion carries no body', async () => {
      // undici's RequestRetryError has `data: { count }` — retry metadata, not the
      // response payload. Reading it as a body would fabricate one.
      const wrapper = new TypeError('fetch failed');
      (wrapper as { cause?: unknown }).cause = {
        name: 'RequestRetryError',
        code: 'UND_ERR_REQ_RETRY',
        statusCode: 503,
        data: { count: 3 },
        headers: { 'retry-after': '5' },
      };
      mockFetch.mockRejectedValueOnce(wrapper);
      const err = (await send().catch((e) => e)) as ConnectorError;
      expect(err.statusCode).toBe(503);
      expect(JSON.stringify(err.cause)).not.toContain('count');
    });

    it('still reports a genuine transport failure as provider_unavailable', async () => {
      const netErr = new TypeError('fetch failed');
      (netErr as { cause?: unknown }).cause = { name: 'SocketError', code: 'UND_ERR_SOCKET' };
      mockFetch.mockRejectedValueOnce(netErr);
      const err = (await send().catch((e) => e)) as ConnectorError;
      expect(err.statusCode).toBeNull();
      expect(err.providerCode).toBe('provider_unavailable');
    });
  });

  describe('credential containment on a transport rejection', () => {
    it('never surfaces the bot token that undici embeds in its message', async () => {
      mockFetch.mockRejectedValueOnce(
        new Error(`request to https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed`),
      );
      const err = (await send().catch((e) => e)) as ConnectorError;
      const serialized = JSON.stringify({ m: err.message, c: err.cause, pm: err.providerMessage });
      expect(serialized).not.toContain(BOT_TOKEN);
      expect(serialized).not.toContain('AAHsecret');
      expect(err.message).toBe('Network error');
    });

    it('keeps the diagnostic code, which names the failure `name` cannot', async () => {
      const netErr = new Error('connect ECONNREFUSED 149.154.167.220:443');
      (netErr as { code?: string }).code = 'ECONNREFUSED';
      mockFetch.mockRejectedValueOnce(netErr);
      const err = (await send().catch((e) => e)) as ConnectorError;
      expect(JSON.stringify(err.cause)).toContain('ECONNREFUSED');
    });

    it('drops a URL-shaped `code` so it cannot smuggle a credential', async () => {
      const netErr = new Error('boom');
      (netErr as { code?: string }).code = `https://api.telegram.org/bot${BOT_TOKEN}/x`;
      mockFetch.mockRejectedValueOnce(netErr);
      const err = (await send().catch((e) => e)) as ConnectorError;
      expect(JSON.stringify(err.cause)).not.toContain(BOT_TOKEN);
    });

    it('preserves `name` so connectors can still detect a cancellation', async () => {
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abort);
      const err = (await send().catch((e) => e)) as ConnectorError;
      expect(err.providerCode).toBe('invalid_request');
    });
  });
});
