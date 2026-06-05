import type { SmsSendInput } from '../../types';

/**
 * Infobip-narrowed extension of `SmsSendInput`. All Infobip-specific fields are
 * optional; baseline `SmsSendInput` (`from?`, `to`, `body`, `_passthrough?`) is
 * preserved verbatim. the >=90% baseline-coverage rule, these
 * fields are below the ≥90% baseline so they do not surface on the universal
 * `SmsSendInput`.
 */
export interface InfobipNarrowedInput extends SmsSendInput {
  /** Group messages for bulk operations. */
  bulkId?: string;
  /** Up to 200 chars, echoed on DLR. */
  callbackData?: string;
  /** DLR callback override. */
  notifyUrl?: string;
  /** DLR callback content type. */
  notifyContentType?: 'application/json' | 'application/xml';
  /** Numeric value paired with `validityPeriodTimeUnit`. */
  validityPeriod?: number;
  /** Unit for `validityPeriod`. */
  validityPeriodTimeUnit?: 'SECONDS' | 'MINUTES' | 'HOURS' | 'DAYS';
  /** Scheduling settings (ISO 8601 `sendAt`). Translates to `sendingDateTime` on the wire. */
  scheduleSettings?: {
    bulkId?: string;
    sendAt?: string;
  };
  /** Class 0 SMS — displayed on screen, not stored. */
  flash?: boolean;
  /** Language hint for transliteration / segmentation. */
  language?: { languageCode?: 'TR' | 'ES' | 'PT' | 'AUTODETECT' };
  /** Transliteration target alphabet. */
  transliteration?:
    | 'TURKISH'
    | 'GREEK'
    | 'CYRILLIC'
    | 'CENTRAL_EUROPEAN'
    | 'PORTUGUESE'
    | 'NON_UNICODE';
}

/**
 * Infobip `POST /sms/2/text/advanced` 2xx response shape. Camel-case wire keys
 * preserved verbatim — this is the raw vendor envelope returned on
 * `SmsSendResult.raw`.
 */
export interface InfobipSendResponse {
  bulkId?: string;
  messages: {
    to: string;
    status: {
      groupId: number;
      groupName: string;
      id: number;
      name: string;
      description: string;
    };
    messageId: string;
    smsCount?: number;
  }[];
}

/**
 * Infobip error response shape. `requestError.serviceException.messageId` is
 * Infobip's `EC_*` code (e.g., `EC_INVALID_DESTINATION_ADDRESS`), preserved
 * on `cause.raw` but not individually mapped to canonical providerCodes.
 */
export interface InfobipErrorResponse {
  requestError?: {
    serviceException?: {
      messageId?: string;
      text?: string;
    };
  };
}
