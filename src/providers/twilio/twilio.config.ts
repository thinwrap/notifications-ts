import type { TwilioRegion } from './twilio.types';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Default sender (E.164 or short code); per-call overridable. */
  from?: string;
  /** Regional cluster selector; omit for the canonical us1 endpoint (`api.twilio.com`). */
  region?: TwilioRegion;
  /** BYO `fetch`. */
  fetch?: typeof fetch;
}
