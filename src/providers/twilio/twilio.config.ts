import type { TwilioEdge, TwilioRegion } from './twilio.types';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Default sender (E.164 or short code); per-call overridable. */
  from?: string;
  /**
   * Processing region; omit for us1 (`api.twilio.com`). `ie1` defaults to the
   * `dublin` edge and `au1` to `sydney`, because Twilio requires an edge in
   * every non-US hostname (`api.{edge}.{region}.twilio.com`). Twilio's
   * regional product-availability page does not list Programmable Messaging
   * among AU1's products.
   */
  region?: TwilioRegion;
  /**
   * Edge location override. With `region` unset it pins the us1 edge
   * (`api.{edge}.us1.twilio.com`).
   */
  edge?: TwilioEdge;
  /** BYO `fetch`. */
  fetch?: typeof fetch;
}
