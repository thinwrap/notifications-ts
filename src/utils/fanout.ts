import { ConnectorError } from '../types/error.types';
import type { ProviderCode } from '../types/error.types';

/**
 * The error a Novu-style multi-target `sendMessage()` throws when every target
 * failed. When all per-target errors agree on a `ProviderCode` (e.g. a single
 * device token answering `429 TooManyProviderTokenUpdates` → `auth_failed`)
 * that code and status are kept, so a caller's retry policy sees the real
 * cause instead of a synthetic 500; otherwise the code is `unknown`. The
 * per-target errors ride on `cause.errors`.
 */
export function allTargetsFailedError(
  provider: string,
  reasons: unknown[],
  messages: string[],
): ConnectorError {
  const codes = reasons.map((r) => (r instanceof ConnectorError ? r.providerCode : undefined));
  const statuses = reasons.map((r) => (r instanceof ConnectorError ? r.statusCode : null));
  const sharedCode: ProviderCode | undefined =
    codes.length > 0 && codes.every((c) => c !== undefined && c === codes[0]) ? codes[0] : undefined;
  const sharedStatus = statuses.every((s) => s === statuses[0]) ? statuses[0] ?? null : null;
  return new ConnectorError({
    message: `All ${reasons.length} ${provider} message(s) failed to send`,
    statusCode: sharedCode !== undefined ? sharedStatus : null,
    providerCode: sharedCode ?? 'unknown',
    providerMessage: messages.join('; '),
    cause: { errors: reasons },
  });
}
