/** Scaleway Transactional Email (TEM) region — physically EU-resident clusters. */
export type ScalewayRegion = 'fr-par' | 'nl-ams' | 'pl-waw';

export interface ScalewayConfig {
  /** Scaleway IAM API secret key (sent verbatim in the `X-Auth-Token` header). */
  secretKey: string;
  /**
   * Scaleway project id. REQUIRED — written to every send as the `project_id`
   * wire field. Account-scoped, so it lives in config rather than per-send input.
   */
  projectId: string;
  /** Default sender email address. */
  from: string;
  /** Optional display name composed into the `from.name` wire field. */
  senderName?: string;
  /**
   * EU region. Defaults to `'fr-par'`. Selected value is interpolated into the
   * endpoint path (`/regions/{region}/emails`) — NOT a host swap.
   */
  region?: ScalewayRegion;
  /** Optional BYO fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
}
