import type { SinchRegion } from './sinch.types';

/**
 * Sinch SMS connector config. Sinch's `xms` (Cross-Messaging Services) API is
 * region-clustered — base URL is `https://<region>.sms.api.sinch.com/...`.
 * Two clusters are exposed: `us` (default) and `eu` for EU data-residency.
 */
export interface SinchConfig {
  /** Sinch Service Plan ID — path parameter. */
  servicePlanId: string;
  /** Bearer token. */
  apiToken: string;
  /** Default sender; per-call overridable via `SinchNarrowedInput.from`. */
  from?: string;
  /** Regional cluster selector. Defaults to `'us'`. */
  region?: SinchRegion;
  /** BYO `fetch` the wrapper holds no state. */
  fetch?: typeof fetch;
}
