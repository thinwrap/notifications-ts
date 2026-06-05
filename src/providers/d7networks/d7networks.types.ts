import type { SmsSendInput } from '../../types';

/**
 * D7-narrowed extension of `SmsSendInput`. All D7-specific fields are optional;
 * baseline `SmsSendInput` (`from?`, `to`, `body`, `_passthrough?`) is preserved
 * verbatim. the >=90% baseline-coverage rule, these fields are
 * below the ≥90% baseline so they do not surface on the universal
 * `SmsSendInput`.
 *
 * D7's wire shape is the most nested of any SMS provider — fields are silently
 * allocated by the connector to either the per-message `messages[]` entry or to
 * the top-level `message_globals` object.
 */
export interface D7NetworksNarrowedInput extends SmsSendInput {
  /** Client tag echoed on DLR (wire: `message_globals.tag`). */
  tag?: string;
  /** Data coding (wire: per-message `data_coding`). */
  dataCoding?: 'auto' | 'text' | 'unicode';
  /** ISO 8601 or relative format (e.g. `'+5 minutes'`) (wire: `message_globals.schedule_time`). */
  scheduleTime?: string;
  /** Carrier-relayed TTL in seconds (wire: `message_globals.validity_period`). */
  validityPeriod?: number;
  /** Overrides `from` and `config.from` (wire: `message_globals.originator`). */
  originator?: string;
  /** DLR webhook URL (wire: `message_globals.report_url`). */
  reportUrl?: string;
  /** Message type (wire: per-message `msg_type`). Defaults to `'text'`. */
  msgType?: 'text' | 'binary' | 'flash';
}

/**
 * D7 `POST /messages/v1/send` 2xx response shape. Snake-case wire keys
 * preserved verbatim — this is the raw vendor envelope returned on
 * `SmsSendResult.raw`.
 */
export interface D7NetworksSendResponse {
  request_id: string;
  status?: string;
  created_at?: string;
}
