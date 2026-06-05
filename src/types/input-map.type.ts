import type { EmailSendInput } from './email.types';
import type { SmsSendInput } from './sms.types';
import type { PushSendInput } from './push.types';
import type { ChatSendInput } from './chat.types';

import type { SesEmailSendInput } from '../providers/ses';
import type { ResendEmailSendInput } from '../providers/resend';
import type { MailgunEmailSendInput } from '../providers/mailgun';
import type { SendgridEmailSendInput } from '../providers/sendgrid';
import type { PostmarkEmailSendInput } from '../providers/postmark';
import type { MailerSendEmailSendInput } from '../providers/mailersend';
import type { MailtrapEmailSendInput } from '../providers/mailtrap';
import type { BrevoEmailSendInput } from '../providers/brevo';
import type { SparkPostEmailSendInput } from '../providers/sparkpost';
import type { ScalewayEmailSendInput } from '../providers/scaleway';

import type { VonageNarrowedInput } from '../providers/vonage';
import type { TwilioNarrowedInput } from '../providers/twilio';
import type { PlivoNarrowedInput } from '../providers/plivo';
import type { SnsNarrowedInput } from '../providers/sns';
import type { SinchNarrowedInput } from '../providers/sinch';
import type { TelnyxNarrowedInput } from '../providers/telnyx';
import type { InfobipNarrowedInput } from '../providers/infobip';
import type { MessageBirdNarrowedInput } from '../providers/messagebird';
import type { TextmagicNarrowedInput } from '../providers/textmagic';
import type { D7NetworksNarrowedInput } from '../providers/d7networks';

import type { FcmPushSendInput } from '../providers/fcm';
import type { ExpoNarrowedInput } from '../providers/expo';
import type { ApnsPushSendInput } from '../providers/apns';
import type { OneSignalNarrowedInput } from '../providers/one-signal';
import type { PusherBeamsPushSendInput } from '../providers/pusher-beams';
import type { WonderPushNarrowedInput } from '../providers/wonderpush';

import type { TelegramNarrowedInput } from '../providers/telegram';
import type { SlackNarrowedInput } from '../providers/slack';
import type { WhatsAppBusinessNarrowedInput } from '../providers/whatsapp-business';
import type { DiscordNarrowedInput } from '../providers/discord';
import type { MsTeamsNarrowedInput } from '../providers/ms-teams';
import type { GoogleChatNarrowedInput } from '../providers/google-chat';
import type { MattermostNarrowedInput } from '../providers/mattermost';
import type { RocketChatNarrowedInput } from '../providers/rocket-chat';
import type { LineNarrowedInput } from '../providers/line';

/**
 * Maps each provider id to its narrowed input type. The facade `send` method
 * uses this map so consumers passing a provider-specific input get full
 * type-narrowing through the facade.
 *
 * Under the >=90% baseline-coverage rule, provider-specific fields
 * are exposed via these narrowed types; baseline fields live on the channel
 * `<Channel>SendInput` interface.
 */
export interface EmailInputMap {
  ses: SesEmailSendInput;
  resend: ResendEmailSendInput;
  mailgun: MailgunEmailSendInput;
  sendgrid: SendgridEmailSendInput;
  postmark: PostmarkEmailSendInput;
  mailersend: MailerSendEmailSendInput;
  mailtrap: MailtrapEmailSendInput;
  brevo: BrevoEmailSendInput;
  sparkpost: SparkPostEmailSendInput;
  scaleway: ScalewayEmailSendInput;
}

export interface SmsInputMap {
  vonage: VonageNarrowedInput;
  twilio: TwilioNarrowedInput;
  plivo: PlivoNarrowedInput;
  sns: SnsNarrowedInput;
  sinch: SinchNarrowedInput;
  telnyx: TelnyxNarrowedInput;
  infobip: InfobipNarrowedInput;
  messagebird: MessageBirdNarrowedInput;
  textmagic: TextmagicNarrowedInput;
  d7networks: D7NetworksNarrowedInput;
}

export interface PushInputMap {
  fcm: FcmPushSendInput;
  expo: ExpoNarrowedInput;
  apns: ApnsPushSendInput;
  'one-signal': OneSignalNarrowedInput;
  'pusher-beams': PusherBeamsPushSendInput;
  wonderpush: WonderPushNarrowedInput;
}

export interface ChatInputMap {
  telegram: TelegramNarrowedInput;
  slack: SlackNarrowedInput;
  'whatsapp-business': WhatsAppBusinessNarrowedInput;
  discord: DiscordNarrowedInput;
  'ms-teams': MsTeamsNarrowedInput;
  'google-chat': GoogleChatNarrowedInput;
  mattermost: MattermostNarrowedInput;
  'rocket-chat': RocketChatNarrowedInput;
  line: LineNarrowedInput;
}

// Re-export base inputs so `EmailInputMap[P] | EmailSendInput` users have one
// import surface.
export type { EmailSendInput, SmsSendInput, PushSendInput, ChatSendInput };
