import type { SmsSendInput } from '../../types';

/**
 * Plivo-specific augmentations of the universal `SmsSendInput`. India DLT
 * compliance fields (`dltEntityId`, `dltTemplateId`, `dltTemplateCategory`)
 * are first-class — surfacing them via `_passthrough` would obscure compliance-
 * mandatory inputs in IntelliSense inline notes.
 *
 * Below-baseline fields the >=90% baseline-coverage rule:
 * delivery-webhook fields (`url`, `method`), tracking toggles (`log`,
 * `trackable`), Powerpack/template references (`powerpackUuid`, `templateId`).
 */
export interface PlivoNarrowedInput extends SmsSendInput {
  /** Delivery-status webhook URL. */
  url?: string;
  /** HTTP method Plivo uses to call `url`. */
  method?: 'GET' | 'POST';
  /** Log message content in the Plivo dashboard. */
  log?: boolean;
  /** Enable URL shortening + click tracking. */
  trackable?: boolean;

  // India DLT compliance (TRAI-mandated):
  /** Principal Entity ID registered with TRAI. */
  dltEntityId?: string;
  /** Content Template ID registered with TRAI. */
  dltTemplateId?: string;
  /** DLT registered template category. */
  dltTemplateCategory?:
    | 'transactional'
    | 'promotional'
    | 'service_implicit'
    | 'service_explicit';

  // Powerpack + Template features:
  /** Plivo Powerpack ID (alternative to `from`). */
  powerpackUuid?: string;
  /** Server-side template reference. */
  templateId?: string;
}

/**
 * Brownfield narrowed input (pre). Preserved as a type alias so the
 * existing `sendMessage()` surface and consumers keep compiling; new
 * code should use {@link PlivoNarrowedInput}.
 */
export interface PlivoSmsSendInput extends Omit<SmsSendInput, 'from'> {
  from: string;
}

/**
 * Plivo Messages API response. `message_uuid` is always an array — typically
 * length 1 for single-recipient sends, but can be longer if the body segmented.
 * See https://www.plivo.com/docs/sms/api/message.
 */
export interface PlivoMessageResponse {
  api_id: string;
  message: string;
  message_uuid: string[];
}

/**
 * Documented shape of a Plivo error response body. Plivo returns
 * `{ api_id, error }` on 4xx/5xx; `api_id` is an opaque request UUID (not an
 * error code).
 */
export interface PlivoErrorResponse {
  api_id?: string;
  error?: string;
}
