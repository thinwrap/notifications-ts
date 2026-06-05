import type { EmailSendInput } from '../../types';

/**
 * Narrowed input for the Scaleway TEM connector. Scaleway-specific extras flow
 * through `_passthrough.body` at v1.0 (e.g., `scheduled_at`, future template
 * fields). The connector's wire shape is snake_case, so `_passthrough.body`
 * keys are casing-transformed to snake_case before merge (mirroring
 * SparkPost). No first-class promotion of vendor extras, per
 * the >=90% baseline-coverage rule.
 */
export type ScalewayEmailSendInput = EmailSendInput;

/** One entry of the Scaleway create-email success response `emails[]` array. */
export interface ScalewayEmailResult {
  id?: string;
  message_id?: string;
  status?: string;
  [key: string]: unknown;
}

/** Scaleway success response shape for POST `/regions/{region}/emails`. */
export interface ScalewaySendEmailResponse {
  emails?: ScalewayEmailResult[];
}

/**
 * Scaleway error response shape. Scaleway returns `{ message, type, fields }`
 * on most validation failures; some routes return `{ errors: [...] }`. Both
 * variants are read defensively in `mapVendorError`.
 */
export interface ScalewayErrorResponse {
  message?: string;
  type?: string;
  fields?: Record<string, unknown>;
  errors?: Array<{ message?: string } & Record<string, unknown>>;
}
