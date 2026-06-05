import type { SmsSendInput } from '../../types';

/**
 * Telnyx-specific augmentations of the universal `SmsSendInput`. Each field
 * captures a documented Telnyx Messaging API parameter that is Telnyx-only and
 * therefore below the 90% baseline-coverage threshold per
 * Per the >=90% baseline-coverage rule; consumers needing further fields
 * flow them through `_passthrough.body`.
 */
export interface TelnyxNarrowedInput extends SmsSendInput {
  /** Alternative to `from` — Telnyx Messaging Profile ID (pool of senders). */
  messagingProfileId?: string;
  /** Per-message webhook override. */
  webhookUrl?: string;
  /** Per-message failover webhook override. */
  webhookFailoverUrl?: string;
  /** Whether to use the profile-level webhook config. */
  useProfileWebhooks?: boolean;
  /** Force SMS or MMS encoding. */
  type?: 'SMS' | 'MMS';
  /** Auto-detect SMS vs MMS based on body. */
  autoDetect?: boolean;
  /** MMS attachments (forces `type='MMS'`). */
  mediaUrls?: string[];
  /** MMS subject line. */
  subject?: string;
}

/**
 * Brownfield narrowed input (pre). Preserved as a type alias so the
 * existing `sendMessage()` surface and consumers keep compiling; new
 * code should use {@link TelnyxNarrowedInput}.
 */
export interface TelnyxSmsSendInput extends Omit<SmsSendInput, 'from'> {
  from: string;
}

/**
 * Telnyx Messaging API response. Documented shape from
 * https://developers.telnyx.com/api/messaging/send-message — successful sends
 * are wrapped in a `{ data: {...} }` JSON:API-style envelope.
 */
export interface TelnyxSendResponse {
  data: {
    id: string;
    record_type?: string;
    direction?: string;
    type?: 'SMS' | 'MMS';
    from?: { phone_number?: string; carrier?: string; line_type?: string };
    to?: Array<{ phone_number: string; status: string; carrier?: string; line_type?: string }>;
    text?: string;
    subject?: string | null;
    media?: Array<{ url: string; content_type?: string; sha256?: string }>;
    webhook_url?: string;
    webhook_failover_url?: string;
    encoding?: string;
    parts?: number;
    tags?: string[];
    cost?: { amount: string; currency: string } | null;
    received_at?: string;
    sent_at?: string | null;
    completed_at?: string | null;
    valid_until?: string | null;
    errors?: Array<{ code?: string; title?: string; detail?: string }>;
    messaging_profile_id?: string | null;
    organization_id?: string;
  };
}

/**
 * Documented shape of a Telnyx error response body. Telnyx returns an `errors`
 * array of `{ code, title, detail, source? }` on 4xx/5xx responses.
 */
export interface TelnyxErrorResponse {
  errors?: Array<{
    code?: string;
    title?: string;
    detail?: string;
    source?: { pointer?: string; parameter?: string };
  }>;
}
