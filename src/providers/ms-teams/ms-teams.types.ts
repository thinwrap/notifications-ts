import type { ChatSendInput } from '../../types';

/**
 * MS Teams-narrowed extension of `ChatSendInput`. `to` is omitted
 * the Incoming Webhook URL itself targets the Teams channel, so there
 * is no separate recipient parameter. Baseline `body` and `_passthrough?` are
 * preserved.
 *
 * Per the >=90% baseline-coverage rule, MS Teams supports the baseline
 * `ChatSendInput` shape **minus `to`** plus a typed `card?: AdaptiveCard`
 * field. When `card` is set, it replaces the default body-as-text card the
 * connector would otherwise synthesize from `body`.
 *
 * MessageCard legacy format (`{ '@type': 'MessageCard', ... }`) is not modeled
 * here — consumers wanting that surface can route via `_passthrough.body`.
 */
export interface MsTeamsNarrowedInput extends Omit<ChatSendInput, 'to'> {
  /**
   * Full Adaptive Card payload. When set, replaces the synthesized body-as-text
   * card. The connector wraps this in the required Teams envelope
   * (`{ type: 'message', attachments: [{ contentType: '...', content: <card> }] }`).
   */
  card?: AdaptiveCard;
}

/**
 * Adaptive Card v1.x shape. Intentionally loose at the element / action level
 * (`[k: string]: unknown`) — Adaptive Cards v1.5 defines 12 element types and
 * 6 action types with deeply nested option arrays; modeling them tightly would
 * inflate the bundle. Consumers wanting strict Adaptive Card typing can use
 * Microsoft's `adaptivecards` npm package alongside (its `IAdaptiveCard`
 * export).
 */
/**
 * Adaptive Card schema URI. Official Microsoft samples still pin the http://
 * form, but the Teams renderer never validates `$schema` (it keys off
 * `type`/`version`), and the https:// URL serves the schema directly while
 * http:// merely 301-redirects to it — so https is safe and avoids the
 * cleartext hop for editor tooling that fetches it.
 */
export const ADAPTIVE_CARD_SCHEMA = 'https://adaptivecards.io/schemas/adaptive-card.json';

export interface AdaptiveCard {
  type: 'AdaptiveCard';
  $schema?: typeof ADAPTIVE_CARD_SCHEMA;
  version: '1.0' | '1.1' | '1.2' | '1.3' | '1.4' | '1.5';
  body?: AdaptiveCardElement[];
  actions?: AdaptiveCardAction[];
  msteams?: { width?: 'Full' | 'Default'; entities?: Array<Record<string, unknown>> };
  [k: string]: unknown;
}

export interface AdaptiveCardElement {
  type:
    | 'TextBlock'
    | 'Image'
    | 'Container'
    | 'ColumnSet'
    | 'FactSet'
    | 'ImageSet'
    | 'ActionSet'
    | 'Media'
    | 'RichTextBlock'
    | string;
  [k: string]: unknown;
}

export interface AdaptiveCardAction {
  type:
    | 'Action.OpenUrl'
    | 'Action.Submit'
    | 'Action.ShowCard'
    | 'Action.ToggleVisibility'
    | 'Action.Execute'
    | string;
  title?: string;
  [k: string]: unknown;
}
