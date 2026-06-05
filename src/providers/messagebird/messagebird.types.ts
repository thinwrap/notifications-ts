import type { SmsSendInput } from '../../types';

/**
 * MessageBird-narrowed extension of `SmsSendInput`. All MessageBird-specific
 * fields are optional; baseline `SmsSendInput` (`from?`, `to`, `body`,
 * `_passthrough?`) is preserved verbatim. Per
 * Per the >=90% baseline-coverage rule, these fields are below the ≥90%
 * baseline so they do not surface on the universal `SmsSendInput`.
 *
 * Note on casing: the narrowed `dataCoding` (camelCase,
 * idiomatic TS) is mapped explicitly to the wire-level `datacoding`
 * (lowercased-flat) inside the connector body. `mclass` is similarly
 * lowercased-flat on the wire. All other wire keys are camelCase.
 */
export interface MessageBirdNarrowedInput extends SmsSendInput {
  /** Message type. Defaults to `'sms'` server-side. */
  type?: 'sms' | 'flash' | 'binary' | 'mms';
  /** Client reference (free-form). */
  reference?: string;
  /** Message validity period in seconds. */
  validity?: number;
  /** Operator gateway override. */
  gateway?: number;
  /** Type-specific details (binary UDH, MMS media, etc.). */
  typeDetails?: Record<string, unknown>;
  /** Body encoding. Wire key is lowercased-flat `datacoding`. */
  dataCoding?: 'plain' | 'unicode' | 'auto';
  /** SMS message class. Wire key is lowercased-flat `mclass`. */
  mclass?: 0 | 1 | 2 | 3;
  /** RFC 3339 — schedule send. */
  scheduledDatetime?: string;
}

/**
 * MessageBird `POST /messages` 2xx response envelope. Returned verbatim on
 * `SmsSendResult.raw` — wire-level casing (mostly camelCase, with
 * `datacoding`/`mclass` lowercased-flat) preserved.
 */
export interface MessageBirdSendResponse {
  id: string;
  href: string;
  direction: string;
  type: string;
  originator: string;
  body: string;
  reference?: string;
  validity?: number;
  gateway: number;
  typeDetails?: Record<string, unknown>;
  datacoding: string;
  mclass: number;
  scheduledDatetime?: string;
  createdDatetime: string;
  recipients: {
    totalCount: number;
    totalSentCount: number;
    totalDeliveredCount: number;
    totalDeliveryFailedCount: number;
    items: Array<{
      recipient: number;
      status: string;
      statusDatetime?: string;
    }>;
  };
}
