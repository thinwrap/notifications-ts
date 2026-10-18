import { describe, it, expect, vi } from 'vitest';
import type { IEmailOptions } from '../types';
import { SendgridEmailConnector } from '../providers/sendgrid/sendgrid.connector';
import { MailtrapEmailConnector } from '../providers/mailtrap/mailtrap.connector';
import { MailerSendEmailConnector } from '../providers/mailersend/mailersend.connector';
import { PostmarkEmailConnector } from '../providers/postmark/postmark.connector';
import { ResendEmailConnector } from '../providers/resend/resend.connector';
import { SparkPostEmailConnector } from '../providers/sparkpost/sparkpost.connector';
import { BrevoEmailConnector } from '../providers/brevo/brevo.connector';
import { SesEmailConnector } from '../providers/ses/ses.connector';

// The Novu `sendMessage()` surface must carry `cid` inline images and
// `options.headers` exactly as each connector's `.send()` does.
const logo = { mime: 'image/png', file: Buffer.from('png'), name: 'logo.png', cid: 'logo' };
const base: IEmailOptions = {
  to: ['r@example.com'],
  subject: 's',
  html: '<img src="cid:logo">',
  headers: { 'X-Campaign': 'c1' },
};

function ok(body: unknown = {}, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function sentBody(f: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
}

describe('Novu sendMessage(): inline cid + headers', () => {
  it('SendGrid: content_id + disposition inline; headers', async () => {
    const f = vi.fn(async () => ok({}, 202, { 'x-message-id': 'm' }));
    await new SendgridEmailConnector({ apiKey: 'k', from: 'a@example.com' }, f as unknown as typeof fetch).sendMessage({
      ...base,
      attachments: [logo],
    });
    const b = sentBody(f);
    expect((b.attachments as Array<Record<string, unknown>>)[0]).toMatchObject({ content_id: 'logo', disposition: 'inline' });
    expect(b.headers).toEqual({ 'X-Campaign': 'c1' });
  });

  it('Mailtrap: content_id + disposition inline; headers', async () => {
    const f = vi.fn(async () => ok({ success: true, message_ids: ['m'] }));
    await new MailtrapEmailConnector(
      { apiToken: 't', mode: 'production', from: 'a@example.com' },
      f as unknown as typeof fetch,
    ).sendMessage({ ...base, attachments: [logo] });
    const b = sentBody(f);
    expect((b.attachments as Array<Record<string, unknown>>)[0]).toMatchObject({ content_id: 'logo', disposition: 'inline' });
    expect(b.headers).toEqual({ 'X-Campaign': 'c1' });
  });

  it('MailerSend: id + disposition inline; headers as [{name, value}]', async () => {
    const f = vi.fn(async () => new Response(null, { status: 202, headers: { 'x-message-id': 'm' } }));
    await new MailerSendEmailConnector({ apiToken: 't', from: 'a@example.com' }, f as unknown as typeof fetch).sendMessage({
      ...base,
      attachments: [logo],
    });
    const b = sentBody(f);
    expect((b.attachments as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'logo', disposition: 'inline' });
    expect(b.headers).toEqual([{ name: 'X-Campaign', value: 'c1' }]);
  });

  it('Postmark: ContentID "cid:<id>"; Headers as [{Name, Value}]', async () => {
    const f = vi.fn(async () => ok({ ErrorCode: 0, MessageID: 'm', Message: 'OK' }));
    await new PostmarkEmailConnector({ serverToken: 't', from: 'a@example.com' }, f as unknown as typeof fetch).sendMessage({
      ...base,
      attachments: [logo],
    });
    const b = sentBody(f);
    expect((b.Attachments as Array<Record<string, unknown>>)[0]).toMatchObject({ ContentID: 'cid:logo' });
    expect(b.Headers).toEqual([{ Name: 'X-Campaign', Value: 'c1' }]);
  });

  it('Resend, SparkPost, Brevo: headers are sent', async () => {
    const r = vi.fn(async () => ok({ id: 'm' }));
    await new ResendEmailConnector({ apiKey: 'k', from: 'a@example.com' }, r as unknown as typeof fetch).sendMessage(base);
    expect(sentBody(r).headers).toEqual({ 'X-Campaign': 'c1' });

    const sp = vi.fn(async () => ok({ results: { id: 'm' } }));
    await new SparkPostEmailConnector({ apiKey: 'k', from: 'a@example.com' }, sp as unknown as typeof fetch).sendMessage(base);
    expect((sentBody(sp).content as Record<string, unknown>).headers).toEqual({ 'X-Campaign': 'c1' });

    const br = vi.fn(async () => ok({ messageId: 'm' }, 201));
    await new BrevoEmailConnector({ apiKey: 'k', from: 'a@example.com' }, br as unknown as typeof fetch).sendMessage(base);
    expect(sentBody(br).headers).toEqual({ 'X-Campaign': 'c1' });
  });

  it('SES: headers go through the Simple-header rules (a reserved name is refused)', async () => {
    const f = vi.fn(async () => ok({ MessageId: 'm' }));
    const ses = new SesEmailConnector(
      { region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'secret', from: 'a@example.com' },
      f as unknown as typeof fetch,
    );
    await ses.sendMessage(base);
    expect(((sentBody(f).Content as Record<string, unknown>).Simple as Record<string, unknown>).Headers).toEqual([
      { Name: 'X-Campaign', Value: 'c1' },
    ]);
    const err = await ses.sendMessage({ ...base, headers: { 'Reply-To': 'x@example.com' } }).catch((e: unknown) => e);
    expect((err as { providerCode?: string }).providerCode).toBe('invalid_request');
  });
});
