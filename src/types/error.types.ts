export type ProviderCode =
  | 'invalid_recipient'
  | 'rate_limited'
  | 'auth_failed'
  | 'provider_unavailable'
  | 'invalid_request'
  | 'unknown';

// providerCode is narrowed to the 6-value `ProviderCode` union. All vendor
// error catches route through canonical `mapXxxErrorToProviderCode()` mappers;
// raw vendor data is preserved on `cause.raw`.
export class ConnectorError extends Error {
  public readonly statusCode: number | null;
  public readonly providerCode?: ProviderCode;
  public readonly providerMessage: string | null;

  constructor(options: {
    message?: string;
    statusCode: number | null;
    providerCode?: ProviderCode;
    providerMessage?: string | null;
    cause?: unknown;
  }) {
    super(
      options.message ?? options.providerMessage ?? 'Connector error',
      { cause: options.cause }
    );
    this.name = 'ConnectorError';
    this.statusCode = options.statusCode;
    this.providerCode = options.providerCode;
    this.providerMessage = options.providerMessage ?? null;
  }
}
