import { ConnectorError } from '../types';

export abstract class BaseConnector {
  protected readonly fetchImpl: typeof fetch;

  protected constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  protected async sendPostJson(
    url: string,
    body: unknown,
    options?: { headers?: Record<string, string>; query?: Record<string, string> },
  ): Promise<Response> {
    return this.invokeFetch(appendQuery(url, options?.query), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(body),
    });
  }

  /**
   * Form-encoded POST with multi-value entry support — array values produce
   * repeated `key=` fields (e.g. Twilio expects multiple `MediaUrl=` fields
   * for MMS, not a comma-joined value). `null`/`undefined` entries are
   * skipped; everything else is `String()`-coerced.
   */
  protected async sendPostForm(
    url: string,
    form: Record<string, unknown>,
    options?: { headers?: Record<string, string>; query?: Record<string, string> },
  ): Promise<Response> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) params.append(key, String(v));
      } else {
        params.append(key, String(value));
      }
    }
    return this.invokeFetch(appendQuery(url, options?.query), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...options?.headers },
      body: params.toString(),
    });
  }

  private async invokeFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new ConnectorError({
          message: (err as Error).message ?? 'Request cancelled',
          statusCode: null,
          providerCode: 'invalid_request',
          cause: err,
        });
      }
      throw new ConnectorError({
        message: (err as Error).message ?? 'Network error',
        statusCode: null,
        providerCode: 'provider_unavailable',
        cause: { raw: err },
      });
    }
  }
}

function appendQuery(url: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${new URLSearchParams(query).toString()}`;
}
