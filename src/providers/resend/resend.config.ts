export interface ResendConfig {
  apiKey: string;
  from: string;
  senderName?: string;
  fetch?: typeof fetch;
}
