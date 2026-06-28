import type { Passthrough } from './passthrough.type';
import type { ChannelTypeEnum } from './channel.enum';

/**
 * Push send input — 4-field baseline (`to`, `title`, `body`, `data`) per the
 * ≥90% baseline-coverage rule.
 * Sub-baseline fields (`badge`, `sound`, `ttl`, …) live on per-provider
 * narrowed inputs (see `PushInputMap`) or flow through `_passthrough`.
 */
export interface PushSendInput {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, string>;
  _passthrough?: Passthrough;
}

export interface PushSendResult {
  success: boolean;
  status: 'sent' | 'queued' | 'rejected' | 'suppressed' | 'unknown';
  providerMessageId: string | null;
  raw: unknown;
}

export interface IPushConnector {
  readonly id: string;
  readonly channelType: ChannelTypeEnum.PUSH;
  send(input: PushSendInput): Promise<PushSendResult>;
}
