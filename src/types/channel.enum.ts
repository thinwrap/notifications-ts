export enum ChannelTypeEnum {
  EMAIL = 'email',
  SMS = 'sms',
  CHAT = 'chat',
  PUSH = 'push',
}

export enum CheckIntegrationResponseEnum {
  INVALID_EMAIL = 'invalid_email',
  BAD_CREDENTIALS = 'bad_credentials',
  SUCCESS = 'success',
  FAILED = 'failed',
}

export enum EmailEventStatusEnum {
  OPENED = 'opened',
  REJECTED = 'rejected',
  SENT = 'sent',
  DEFERRED = 'deferred',
  DELIVERED = 'delivered',
  BOUNCED = 'bounced',
  DROPPED = 'dropped',
  CLICKED = 'clicked',
  BLOCKED = 'blocked',
  SPAM = 'spam',
  UNSUBSCRIBED = 'unsubscribed',
  DELAYED = 'delayed',
  COMPLAINT = 'complaint',
}

export enum SmsEventStatusEnum {
  CREATED = 'created',
  DELIVERED = 'delivered',
  ACCEPTED = 'accepted',
  QUEUED = 'queued',
  SENDING = 'sending',
  SENT = 'sent',
  FAILED = 'failed',
  UNDELIVERED = 'undelivered',
  REJECTED = 'rejected',
}

export enum PushEventStatusEnum {
  DELIVERED = 'delivered',
  OPENED = 'opened',
  DISMISSED = 'dismissed',
  CLICKED = 'clicked',
  FAILED = 'failed',
}
