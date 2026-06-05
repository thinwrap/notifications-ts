import type { SmsSendInput } from '../../types';

/**
 * SMS-eligible AWS regions for SNS. Sourced from
 * https://docs.aws.amazon.com/sns/latest/dg/sms_supported-countries.html;
 * SNS SMS publishing requires one of these regions.
 */
export type SnsRegion =
  | 'us-east-1'
  | 'us-east-2'
  | 'us-west-1'
  | 'us-west-2'
  | 'eu-west-1'
  | 'eu-west-2'
  | 'eu-west-3'
  | 'eu-central-1'
  | 'eu-north-1'
  | 'ap-northeast-1'
  | 'ap-northeast-2'
  | 'ap-south-1'
  | 'ap-southeast-1'
  | 'ap-southeast-2'
  | 'ca-central-1'
  | 'sa-east-1';

/**
 * Shape of an individual SNS `MessageAttributes` entry. AWS Query API requires
 * indexed-key form on the wire (`MessageAttributes.entry.N.Name`, `.Value.DataType`,
 * `.Value.StringValue` / `.Value.BinaryValue`); the connector flattens this
 * consumer-friendly record into that form before Sig V4 signing.
 */
export interface SnsMessageAttribute {
  DataType: 'String' | 'Number' | 'Binary' | 'String.Array';
  StringValue?: string;
  /** Base64-encoded for `Binary`. */
  BinaryValue?: string;
}

/**
 * SNS-specific augmentations of the universal `SmsSendInput`. SNS supports
 * either phone-number publishes (`to`) or topic publishes (`topicArn`); when
 * `topicArn` is set, `to` is not required. SMS-convenience fields (`smsType`,
 * `senderId`, `maxPrice`) are flattened into `MessageAttributes` per the
 * documented `AWS.SNS.SMS.*` attribute names.
 */
export interface SnsNarrowedInput extends SmsSendInput {
  /** Topic ARN target — alternative to phone number (one of `to`/`topicArn` required). */
  topicArn?: string;
  /** `json` for multi-protocol payloads; default = plain string for SMS. */
  messageStructure?: 'json' | 'string';
  messageAttributes?: Record<string, SnsMessageAttribute>;
  /** Flattened into `AWS.SNS.SMS.SMSType`. */
  smsType?: 'Promotional' | 'Transactional';
  /** Flattened into `AWS.SNS.SMS.SenderID`. */
  senderId?: string;
  /** Per-message USD price cap; flattened into `AWS.SNS.SMS.MaxPrice`. */
  maxPrice?: string;
}

/**
 * Brownfield narrowed input (pre). Preserved as a type alias so the
 * existing `sendMessage()` surface keeps compiling; new code should use
 * {@link SnsNarrowedInput}.
 */
export interface SnsSmsSendInput extends Omit<SmsSendInput, 'from'> {
  from: string;
}

export interface SnsPublishResponse {
  PublishResponse: {
    PublishResult: {
      MessageId: string;
    };
  };
}
