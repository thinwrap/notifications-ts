import type { ProviderConfigMap, SmsProvider } from '../types';
import type {
  SmsSendInput,
  SmsSendResult,
  ISmsConnector,
} from '../types';
import type { SmsInputMap } from '../types/input-map.type';
import { ChannelTypeEnum } from '../types';
import { ConnectorError } from '../types';
import { VonageSmsConnector } from '../providers/vonage';
import { TwilioSmsConnector } from '../providers/twilio';
import { PlivoSmsConnector } from '../providers/plivo';
import { SnsSmsConnector } from '../providers/sns';
import { SinchSmsConnector } from '../providers/sinch';
import { TelnyxSmsConnector } from '../providers/telnyx';
import { InfobipSmsConnector } from '../providers/infobip';
import { MessageBirdSmsConnector } from '../providers/messagebird';
import { TextmagicSmsConnector } from '../providers/textmagic';
import { D7NetworksSmsConnector } from '../providers/d7networks';

type SmsFacadeInput<P extends SmsProvider> = P extends keyof SmsInputMap
  ? SmsInputMap[P]
  : SmsSendInput;

type SmsConfigWithFetch<P extends SmsProvider> = ProviderConfigMap[P] & {
  fetch?: typeof fetch;
};

export class Sms<P extends SmsProvider = SmsProvider> {
  public readonly id: string;
  public readonly channelType = ChannelTypeEnum.SMS;
  private readonly connector: ISmsConnector;

  constructor(providerId: P, config: SmsConfigWithFetch<P>);
  constructor(connector: ISmsConnector);
  constructor(arg: P | ISmsConnector, config?: SmsConfigWithFetch<P>) {
    if (typeof arg === 'object' && arg !== null) {
      this.id = arg.id;
      this.connector = arg;
      return;
    }
    if (!config) {
      throw new ConnectorError({
        message: 'Sms facade requires `config` when constructed with a provider id',
        statusCode: null,
        providerCode: 'invalid_request',
      });
    }
    const providerId = arg;
    this.id = providerId;
    const customFetch = config.fetch;
    switch (providerId) {
      case 'vonage':
        this.connector = new VonageSmsConnector(config as ProviderConfigMap['vonage'], customFetch);
        break;
      case 'twilio':
        this.connector = new TwilioSmsConnector(config as ProviderConfigMap['twilio'], customFetch);
        break;
      case 'plivo':
        this.connector = new PlivoSmsConnector(config as ProviderConfigMap['plivo'], customFetch);
        break;
      case 'sns':
        this.connector = new SnsSmsConnector(config as ProviderConfigMap['sns'], customFetch);
        break;
      case 'sinch':
        this.connector = new SinchSmsConnector(config as ProviderConfigMap['sinch'], customFetch);
        break;
      case 'telnyx':
        this.connector = new TelnyxSmsConnector(config as ProviderConfigMap['telnyx'], customFetch);
        break;
      case 'infobip':
        this.connector = new InfobipSmsConnector(config as ProviderConfigMap['infobip'], customFetch);
        break;
      case 'messagebird':
        this.connector = new MessageBirdSmsConnector(config as ProviderConfigMap['messagebird'], customFetch);
        break;
      case 'textmagic':
        this.connector = new TextmagicSmsConnector(config as ProviderConfigMap['textmagic'], customFetch);
        break;
      case 'd7networks':
        this.connector = new D7NetworksSmsConnector(config as ProviderConfigMap['d7networks'], customFetch);
        break;
      default:
        throw new ConnectorError({
          message: `Unsupported SMS provider: ${providerId as string}`,
          statusCode: null,
          providerCode: 'invalid_request',
        });
    }
  }

  async send(input: SmsFacadeInput<P>): Promise<SmsSendResult> {
    return this.connector.send(input as SmsSendInput);
  }

  async checkIntegration(): Promise<{ success: boolean; message?: string }> {
    const c = this.connector as ISmsConnector & {
      checkIntegration?: () => Promise<unknown>;
    };
    if (typeof c.checkIntegration === 'function') {
      try {
        const result = await c.checkIntegration();
        return { success: true, message: JSON.stringify(result) };
      } catch (err) {
        return { success: false, message: (err as Error).message };
      }
    }
    return { success: true, message: 'connector does not implement checkIntegration' };
  }
}
