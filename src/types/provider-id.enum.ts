export enum EmailProviderIdEnum {
  SES = 'ses',
  Resend = 'resend',
  Mailgun = 'mailgun',
  Sendgrid = 'sendgrid',
  Postmark = 'postmark',
  MailerSend = 'mailersend',
  Mailtrap = 'mailtrap',
  Brevo = 'brevo',
  SparkPost = 'sparkpost',
  Scaleway = 'scaleway',
}

export enum SmsProviderIdEnum {
  Vonage = 'vonage',
  Twilio = 'twilio',
  Plivo = 'plivo',
  SNS = 'sns',
  Sinch = 'sinch',
  Telnyx = 'telnyx',
  Infobip = 'infobip',
  MessageBird = 'messagebird',
  Textmagic = 'textmagic',
  D7Networks = 'd7networks',
}

export enum PushProviderIdEnum {
  FCM = 'fcm',
  EXPO = 'expo',
  APNS = 'apns',
  OneSignal = 'one-signal',
  PusherBeams = 'pusher-beams',
  WonderPush = 'wonderpush',
}

export enum ChatProviderIdEnum {
  Telegram = 'telegram',
  Slack = 'slack',
  WhatsAppBusiness = 'whatsapp-business',
  Discord = 'discord',
  MsTeams = 'ms-teams',
  GoogleChat = 'google-chat',
  Mattermost = 'mattermost',
  RocketChat = 'rocket-chat',
  LINE = 'line',
}

// ---------------------------------------------------------------------------
// Compile-time sync assertions — each enum's value set must exactly equal the
// corresponding provider-id union derived from ProviderConfigMap. An enum
// member that drifts from (or misses) a config-map key fails `npm run
// typecheck`. Enum members are assignable to their literal values, so
// `new Email(EmailProviderIdEnum.Sendgrid, ...)` stays interchangeable with
// `new Email('sendgrid', ...)`.
// ---------------------------------------------------------------------------
import type {
  EmailProvider,
  SmsProvider,
  PushProvider,
  ChatProvider,
} from './config-map.type';

type Extends<A extends B, B> = A;

type _EmailEnumWithinUnion = Extends<`${EmailProviderIdEnum}`, EmailProvider>;
type _EmailEnumCoversUnion = Extends<EmailProvider, `${EmailProviderIdEnum}`>;
type _SmsEnumWithinUnion = Extends<`${SmsProviderIdEnum}`, SmsProvider>;
type _SmsEnumCoversUnion = Extends<SmsProvider, `${SmsProviderIdEnum}`>;
type _PushEnumWithinUnion = Extends<`${PushProviderIdEnum}`, PushProvider>;
type _PushEnumCoversUnion = Extends<PushProvider, `${PushProviderIdEnum}`>;
type _ChatEnumWithinUnion = Extends<`${ChatProviderIdEnum}`, ChatProvider>;
type _ChatEnumCoversUnion = Extends<ChatProvider, `${ChatProviderIdEnum}`>;
