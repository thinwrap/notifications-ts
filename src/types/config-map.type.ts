import type { SesConfig } from '../providers/ses';
import type { ResendConfig } from '../providers/resend';
import type { MailgunConfig } from '../providers/mailgun';
import type { SendgridConfig } from '../providers/sendgrid';
import type { PostmarkConfig } from '../providers/postmark';
import type { MailerSendConfig } from '../providers/mailersend';
import type { MailtrapConfig } from '../providers/mailtrap';
import type { BrevoConfig } from '../providers/brevo';
import type { SparkPostConfig } from '../providers/sparkpost';
import type { ScalewayConfig } from '../providers/scaleway';
import type { VonageConfig } from '../providers/vonage';
import type { TwilioConfig } from '../providers/twilio';
import type { PlivoConfig } from '../providers/plivo';
import type { SnsConfig } from '../providers/sns';
import type { SinchConfig } from '../providers/sinch';
import type { TelnyxConfig } from '../providers/telnyx';
import type { InfobipConfig } from '../providers/infobip';
import type { MessageBirdConfig } from '../providers/messagebird';
import type { TextmagicConfig } from '../providers/textmagic';
import type { D7NetworksConfig } from '../providers/d7networks';
import type { FcmConfig } from '../providers/fcm';
import type { ExpoConfig } from '../providers/expo';
import type { ApnsConfig } from '../providers/apns';
import type { OneSignalConfig } from '../providers/one-signal';
import type { PusherBeamsConfig } from '../providers/pusher-beams';
import type { WonderPushConfig } from '../providers/wonderpush';
import type { TelegramConfig } from '../providers/telegram';
import type { SlackConfig } from '../providers/slack';
import type { WhatsAppBusinessConfig } from '../providers/whatsapp-business';
import type { DiscordConfig } from '../providers/discord';
import type { MsTeamsConfig } from '../providers/ms-teams';
import type { GoogleChatConfig } from '../providers/google-chat';
import type { MattermostConfig } from '../providers/mattermost';
import type { RocketChatConfig } from '../providers/rocket-chat';
import type { LineConfig } from '../providers/line';

export interface ProviderConfigMap {
  ses: SesConfig;
  resend: ResendConfig;
  mailgun: MailgunConfig;
  sendgrid: SendgridConfig;
  postmark: PostmarkConfig;
  mailersend: MailerSendConfig;
  mailtrap: MailtrapConfig;
  brevo: BrevoConfig;
  sparkpost: SparkPostConfig;
  scaleway: ScalewayConfig;

  vonage: VonageConfig;
  twilio: TwilioConfig;
  plivo: PlivoConfig;
  sns: SnsConfig;
  sinch: SinchConfig;
  telnyx: TelnyxConfig;
  infobip: InfobipConfig;
  messagebird: MessageBirdConfig;
  textmagic: TextmagicConfig;
  d7networks: D7NetworksConfig;

  fcm: FcmConfig;
  expo: ExpoConfig;
  apns: ApnsConfig;
  'one-signal': OneSignalConfig;
  'pusher-beams': PusherBeamsConfig;
  wonderpush: WonderPushConfig;

  telegram: TelegramConfig;
  slack: SlackConfig;
  'whatsapp-business': WhatsAppBusinessConfig;
  discord: DiscordConfig;
  'ms-teams': MsTeamsConfig;
  'google-chat': GoogleChatConfig;
  mattermost: MattermostConfig;
  'rocket-chat': RocketChatConfig;
  line: LineConfig;
}

export type EmailProvider = keyof Pick<
  ProviderConfigMap,
  | 'ses'
  | 'resend'
  | 'mailgun'
  | 'sendgrid'
  | 'postmark'
  | 'mailersend'
  | 'mailtrap'
  | 'brevo'
  | 'sparkpost'
  | 'scaleway'
>;

export type SmsProvider = keyof Pick<
  ProviderConfigMap,
  | 'vonage'
  | 'twilio'
  | 'plivo'
  | 'sns'
  | 'sinch'
  | 'telnyx'
  | 'infobip'
  | 'messagebird'
  | 'textmagic'
  | 'd7networks'
>;

export type PushProvider = keyof Pick<
  ProviderConfigMap,
  'fcm' | 'expo' | 'apns' | 'one-signal' | 'pusher-beams' | 'wonderpush'
>;

export type ChatProvider = keyof Pick<
  ProviderConfigMap,
  | 'telegram'
  | 'slack'
  | 'whatsapp-business'
  | 'discord'
  | 'ms-teams'
  | 'google-chat'
  | 'mattermost'
  | 'rocket-chat'
  | 'line'
>;
