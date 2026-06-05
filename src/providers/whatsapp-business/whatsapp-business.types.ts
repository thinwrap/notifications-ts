import type { ChatSendInput } from '../../types';

/**
 * WhatsApp Business-narrowed extension of `ChatSendInput`. `to` is REQUIRED
 * (E.164 phone number, e.g. `'+14155552671'`).
 *
 * Per the >=90% baseline-coverage rule, the narrowed fields below
 * cover the three highest-value Cloud API request shapes (text / template /
 * interactive) plus `context` (reply-to-message) and `previewUrl` (text
 * preview toggle). Other types (image, document, video, audio, location,
 * contacts) accept the `type` discriminator but the connector does NOT
 * synthesize media-upload shapes in v1.0 — consumers route those via
 * `_passthrough.body.*`.
 */
export interface WhatsAppBusinessNarrowedInput extends ChatSendInput {
  /** REQUIRED — E.164 phone number (e.g. '+14155552671'). */
  to: string;
  /** Message-type discriminator. Defaults to `'text'` at runtime. */
  type?:
    | 'text'
    | 'template'
    | 'interactive'
    | 'image'
    | 'document'
    | 'video'
    | 'audio'
    | 'location'
    | 'contacts';
  /** HSM template payload (when `type === 'template'`). Body is ignored. */
  template?: WhatsAppTemplate;
  /** Interactive message payload (when `type === 'interactive'`). Body is ignored. */
  interactive?: WhatsAppInteractive;
  /** Reply-to-message context. Wire shape: `{ message_id }`. */
  context?: { messageId: string };
  /** Wire key `text.preview_url` — toggle URL preview on text messages. */
  previewUrl?: boolean;
}

export interface WhatsAppTemplate {
  name: string;
  language: { code: string };
  components?: WhatsAppTemplateComponent[];
}

export interface WhatsAppTemplateComponent {
  type: 'header' | 'body' | 'button' | 'footer';
  parameters?: Array<{
    type: string;
    text?: string;
    image?: { link: string };
    [k: string]: unknown;
  }>;
  /** Wire key `sub_type` — for `type: 'button'`. */
  sub_type?: 'quick_reply' | 'url' | 'catalog' | 'flow';
  /** Button position index — for `type: 'button'`. */
  index?: string;
}

export interface WhatsAppInteractive {
  type: 'button' | 'list' | 'product' | 'product_list' | 'cta_url' | 'flow';
  header?: {
    type: 'text' | 'image' | 'video' | 'document';
    text?: string;
    image?: { link: string };
    [k: string]: unknown;
  };
  body: { text: string };
  footer?: { text: string };
  action: WhatsAppInteractiveAction;
}

export interface WhatsAppInteractiveAction {
  buttons?: Array<{ type: 'reply'; reply: { id: string; title: string } }>;
  /** Button label for `type: 'list'`. */
  button?: string;
  sections?: Array<{
    title?: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
  [k: string]: unknown;
}

/**
 * Meta Graph API response envelope for `POST /<phone_number_id>/messages`.
 * Success path emits `messages: [{ id }]`; failure path emits `error: {...}`.
 */
export interface WhatsAppResponse {
  messaging_product?: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string; message_status?: string }>;
  error?: {
    code: number;
    error_subcode?: number;
    message: string;
    type?: string;
    fbtrace_id?: string;
  };
}
