import { describe, it, expect, vi } from 'vitest';
import { ConnectorError } from '../types';
import { SendgridEmailConnector } from '../providers/sendgrid/sendgrid.connector';
import { TwilioSmsConnector } from '../providers/twilio/twilio.connector';

// A header name/value with CR, LF or NUL is refused before the request is
// built (header injection; undici would otherwise throw an opaque TypeError).
// The error names the header, never the value — values hold credentials.
describe('header guard (CR/LF/NUL)', () => {
  it('an API key with a trailing newline (typical .env paste) → invalid_request naming Authorization only', async () => {
    const f = vi.fn();
    const sg = new SendgridEmailConnector({ apiKey: 'SG.secret-value\n', from: 'a@example.com' }, f as unknown as typeof fetch);
    const err = (await sg
      .send({ from: 'a@example.com', to: 'r@example.com', subject: 's', text: 't' })
      .catch((e: unknown) => e)) as ConnectorError;
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.providerCode).toBe('invalid_request');
    expect(err.message).toContain('Authorization');
    expect(err.message).not.toContain('secret-value');
    expect(JSON.stringify(err.cause ?? null)).not.toContain('secret-value');
    expect(f).not.toHaveBeenCalled();
  });

  it('a passthrough header value with CR/LF on the form path → invalid_request', async () => {
    const f = vi.fn();
    const tw = new TwilioSmsConnector({ accountSid: 'AC1', authToken: 't', from: '+1' }, f as unknown as typeof fetch);
    const err = (await tw
      .send({ to: '+15550000000', body: 'hi', _passthrough: { headers: { 'X-Trace': 'a\r\nX-Evil: 1' } } })
      .catch((e: unknown) => e)) as ConnectorError;
    expect(err.providerCode).toBe('invalid_request');
    expect(err.message).toContain('X-Trace');
    expect(err.message).not.toContain('X-Evil');
    expect(f).not.toHaveBeenCalled();
  });

  it('a header NAME with a newline → invalid_request without echoing the name', async () => {
    const f = vi.fn();
    const tw = new TwilioSmsConnector({ accountSid: 'AC1', authToken: 't', from: '+1' }, f as unknown as typeof fetch);
    const err = (await tw
      .send({ to: '+15550000000', body: 'hi', _passthrough: { headers: { 'X-A\nX-Evil': 'v' } } })
      .catch((e: unknown) => e)) as ConnectorError;
    expect(err.providerCode).toBe('invalid_request');
    expect(err.message).not.toContain('X-Evil');
    expect(f).not.toHaveBeenCalled();
  });
});
