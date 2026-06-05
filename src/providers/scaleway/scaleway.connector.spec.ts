import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { ScalewayEmailConnector } from './scaleway.connector';
import type { ScalewayConfig } from './scaleway.config';
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

const defaultConfig: ScalewayConfig = {
  secretKey: 'scw-secret-123',
  projectId: 'proj-abc',
  from: 'sender@example.com',
  senderName: 'Test Sender',
};

function successResponse(
  emails: Array<Record<string, unknown>> = [
    { id: 'eml-1', message_id: 'msg-1', status: 'new' },
  ],
): Response {
  return new Response(JSON.stringify({ emails }), { status: 200 });
}

function errorResponse(
  status: number,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function lastBody(): Record<string, unknown> {
  const [, init] = mockFetch.mock.calls[0]!;
  return JSON.parse((init as RequestInit).body as string) as Record<
    string,
    unknown
  >;
}

describe('ScalewayEmailConnector', () => {
  let connector: ScalewayEmailConnector;

  beforeEach(() => {
    mockFetch.mockReset();
    connector = new ScalewayEmailConnector(defaultConfig);
  });

  it('exposes id and channelType', () => {
    expect(connector.id).toBe('scaleway');
    expect(connector.channelType).toBe(ChannelTypeEnum.EMAIL);
  });

  // ---------------------------------------------------------------------------
  // Endpoint + auth
  // ---------------------------------------------------------------------------

  it('POSTs to the default fr-par region path with X-Auth-Token auth', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await connector.send({
      from: 'sender@example.com',
      to: 'a@x',
      subject: 'S',
      html: '<p>Hi</p>',
    });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails',
    );
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Auth-Token']).toBe('scw-secret-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('interpolates a non-default region into the path', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());
    const nl = new ScalewayEmailConnector({ ...defaultConfig, region: 'nl-ams' });

    await nl.send({ from: 'a@b', to: 'a@x', subject: 'S', text: 'hi' });

    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://api.scaleway.com/transactional-email/v1alpha1/regions/nl-ams/emails',
    );
  });

  // ---------------------------------------------------------------------------
  // Body construction
  // ---------------------------------------------------------------------------

  it('builds nested from/to address objects, project_id, and senderName', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await connector.send({
      from: 'override@example.com',
      to: 'a@x',
      subject: 'Hello',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    const body = lastBody();
    expect(body.from).toEqual({
      email: 'override@example.com',
      name: 'Test Sender',
    });
    expect(body.to).toEqual([{ email: 'a@x' }]);
    expect(body.project_id).toBe('proj-abc');
    expect(body.subject).toBe('Hello');
    expect(body.html).toBe('<p>Hi</p>');
    expect(body.text).toBe('Hi');
  });

  it('maps cc/bcc to arrays of address objects (no header_to games)', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await connector.send({
      from: 'a@b',
      to: 'a@x',
      cc: ['c@y'],
      bcc: ['b@z'],
      subject: 'S',
      text: 'hi',
    });

    const body = lastBody();
    expect(body.cc).toEqual([{ email: 'c@y' }]);
    expect(body.bcc).toEqual([{ email: 'b@z' }]);
  });

  it('maps headers to additional_headers {key,value} and folds replyTo in as Reply-To', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await connector.send({
      from: 'a@b',
      to: 'a@x',
      subject: 'S',
      text: 'hi',
      replyTo: 'reply@example.com',
      headers: { 'X-Custom': 'v1' },
    });

    expect(lastBody().additional_headers).toEqual([
      { key: 'Reply-To', value: 'reply@example.com' },
      { key: 'X-Custom', value: 'v1' },
    ]);
  });

  it('base64-encodes attachments and defaults missing mime to application/octet-stream', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await connector.send({
      from: 'a@b',
      to: 'a@x',
      subject: 'S',
      text: 'hi',
      attachments: [
        { filename: 'a.txt', content: 'hello', contentType: 'text/plain' },
        { filename: 'b.bin', content: 'data' },
        { filename: 'c.bin', content: 'data', contentType: '' },
      ],
    });

    expect(lastBody().attachments).toEqual([
      { name: 'a.txt', type: 'text/plain', content: Buffer.from('hello').toString('base64') },
      {
        name: 'b.bin',
        type: 'application/octet-stream',
        content: Buffer.from('data').toString('base64'),
      },
      {
        name: 'c.bin',
        type: 'application/octet-stream',
        content: Buffer.from('data').toString('base64'),
      },
    ]);
  });

  it('silently drops tags and attachment contentId (no Scaleway field at v1.0)', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await connector.send({
      from: 'a@b',
      to: 'a@x',
      subject: 'S',
      text: 'hi',
      tags: ['t1', 't2'],
      attachments: [{ filename: 'a.png', content: 'x', contentId: 'cid1' }],
    });

    const body = lastBody();
    expect(body.tags).toBeUndefined();
    expect((body.attachments as Array<Record<string, unknown>>)[0]).not.toHaveProperty('contentId');
  });

  it('transforms _passthrough.body keys to snake_case before merge', async () => {
    mockFetch.mockResolvedValueOnce(successResponse());

    await connector.send({
      from: 'a@b',
      to: 'a@x',
      subject: 'S',
      text: 'hi',
      _passthrough: { body: { scheduledAt: '2026-06-03T00:00:00Z' } },
    });

    const body = lastBody();
    expect(body.scheduled_at).toBe('2026-06-03T00:00:00Z');
    expect(body).not.toHaveProperty('scheduledAt');
  });

  // ---------------------------------------------------------------------------
  // Success mapping
  // ---------------------------------------------------------------------------

  it('maps a 2xx accept to queued with message_id as providerMessageId', async () => {
    mockFetch.mockResolvedValueOnce(
      successResponse([{ id: 'eml-9', message_id: 'msg-9', status: 'new' }]),
    );

    const res = await connector.send({
      from: 'a@b',
      to: 'a@x',
      subject: 'S',
      text: 'hi',
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe('queued');
    expect(res.providerMessageId).toBe('msg-9');
  });

  it('falls back to emails[0].id when message_id is absent', async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ id: 'eml-only' }]));

    const res = await connector.send({ from: 'a@b', to: 'a@x', subject: 'S', text: 'hi' });
    expect(res.providerMessageId).toBe('eml-only');
  });

  it('treats a 2xx with empty emails array as success with null id (no synthesized error)', async () => {
    mockFetch.mockResolvedValueOnce(successResponse([]));

    const res = await connector.send({ from: 'a@b', to: 'a@x', subject: 'S', text: 'hi' });
    expect(res.success).toBe(true);
    expect(res.status).toBe('queued');
    expect(res.providerMessageId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Error mapping
  // ---------------------------------------------------------------------------

  it.each([
    [400, 'invalid_request'],
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [404, 'invalid_request'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ])('maps HTTP %i to providerCode %s', async (status, code) => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(status, { message: 'boom', type: 'some_error' }),
    );

    await expect(
      connector.send({ from: 'a@b', to: 'a@x', subject: 'S', text: 'hi' }),
    ).rejects.toMatchObject({ providerCode: code, statusCode: status });
  });

  it('reads message from the errors[] variant', async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(400, { errors: [{ message: 'bad field' }] }),
    );

    await expect(
      connector.send({ from: 'a@b', to: 'a@x', subject: 'S', text: 'hi' }),
    ).rejects.toMatchObject({ providerMessage: 'bad field' });
  });

  it('surfaces Retry-After via providerMessage + cause.retryAfter', async () => {
    mockFetch.mockResolvedValueOnce(
      createRetryAfterFixture({ status: 429, retryAfter: '30', errorBody: { message: 'throttled' } }),
    );

    await expect(
      connector.send({ from: 'a@b', to: 'a@x', subject: 'S', text: 'hi' }),
    ).rejects.toMatchObject({
      providerCode: 'rate_limited',
      providerMessage: expect.stringContaining('30'),
      cause: expect.objectContaining({ retryAfter: '30' }),
    });
  });

  it('does not put a top-level retryAfterSeconds field on the error', async () => {
    mockFetch.mockResolvedValueOnce(
      createRetryAfterFixture({ status: 429, retryAfter: '12', errorBody: { message: 'throttled' } }),
    );

    const err = await connector
      .send({ from: 'a@b', to: 'a@x', subject: 'S', text: 'hi' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectorError);
    if (!(err instanceof ConnectorError)) throw new Error('expected ConnectorError');
    expect((err as unknown as Record<string, unknown>).retryAfterSeconds).toBeUndefined();
    expect((err.cause as Record<string, unknown>).retryAfterSeconds).toBe(12);
  });

  // ---------------------------------------------------------------------------
  // Transport failures
  // ---------------------------------------------------------------------------

  it('maps a network failure to provider_unavailable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket hang up'));

    await expect(
      connector.send({ from: 'a@b', to: 'a@x', subject: 'S', text: 'hi' }),
    ).rejects.toMatchObject({ providerCode: 'provider_unavailable', statusCode: null });
  });

  it('maps an abort to invalid_request', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockFetch.mockRejectedValueOnce(abortErr);

    await expect(
      connector.send({ from: 'a@b', to: 'a@x', subject: 'S', text: 'hi' }),
    ).rejects.toMatchObject({ providerCode: 'invalid_request', statusCode: null });
  });
});
