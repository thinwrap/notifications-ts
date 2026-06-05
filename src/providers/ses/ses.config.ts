export interface SesConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  from: string;
  senderName?: string;
  configurationSetName?: string;
  fetch?: typeof fetch;
}
