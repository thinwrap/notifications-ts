export interface WonderPushConfig {
  /**
   * Management API access token from the WonderPush dashboard. Sent as a
   * Bearer credential per the canonical Thinwrap auth pattern (the legacy
   * `?accessToken=` query-param form is no longer used).
   */
  accessToken: string;

  /**
   * Optional WonderPush application identifier. Required by certain
   * deliveries endpoints; when set, forwarded into the request body as
   * `applicationId`.
   */
  applicationId?: string;

  /** BYO fetch hook the wrapper holds no state. */
  fetch?: typeof fetch;
}
