import type { SnsRegion } from './sns.types';

export interface SnsConfig {
  /** SMS-eligible AWS region for SNS — required, no environment inference. */
  region: SnsRegion;
  accessKeyId: string;
  secretAccessKey: string;
  /** STS-issued temporary session token; signed and sent as `X-Amz-Security-Token` when present. */
  sessionToken?: string;
  /** BYO `fetch`. */
  fetch?: typeof fetch;
}
