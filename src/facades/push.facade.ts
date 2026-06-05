import type { ProviderConfigMap, PushProvider } from '../types';
import type {
  PushSendInput,
  PushSendResult,
  IPushConnector,
} from '../types';
import type { PushInputMap } from '../types/input-map.type';
import { ChannelTypeEnum } from '../types';
import { ConnectorError } from '../types';
import { FcmPushConnector } from '../providers/fcm';
import { ExpoPushConnector } from '../providers/expo';
import { ApnsPushConnector } from '../providers/apns';
import { OneSignalPushConnector } from '../providers/one-signal';
import { PusherBeamsPushConnector } from '../providers/pusher-beams';
import { WonderPushPushConnector } from '../providers/wonderpush';

type PushFacadeInput<P extends PushProvider> = P extends keyof PushInputMap
  ? PushInputMap[P]
  : PushSendInput;

type PushConfigWithFetch<P extends PushProvider> = ProviderConfigMap[P] & {
  fetch?: typeof fetch;
};

export class Push<P extends PushProvider = PushProvider> {
  public readonly id: string;
  public readonly channelType = ChannelTypeEnum.PUSH;
  private readonly connector: IPushConnector;

  constructor(providerId: P, config: PushConfigWithFetch<P>);
  constructor(connector: IPushConnector);
  constructor(arg: P | IPushConnector, config?: PushConfigWithFetch<P>) {
    if (typeof arg === 'object' && arg !== null) {
      this.id = arg.id;
      this.connector = arg;
      return;
    }
    if (!config) {
      throw new ConnectorError({
        message: 'Push facade requires `config` when constructed with a provider id',
        statusCode: null,
        providerCode: 'invalid_request',
      });
    }
    const providerId = arg;
    this.id = providerId;
    const customFetch = config.fetch;
    switch (providerId) {
      case 'fcm':
        this.connector = new FcmPushConnector(config as ProviderConfigMap['fcm'], customFetch);
        break;
      case 'expo':
        this.connector = new ExpoPushConnector(config as ProviderConfigMap['expo'], customFetch);
        break;
      case 'apns':
        this.connector = new ApnsPushConnector(config as ProviderConfigMap['apns'], customFetch);
        break;
      case 'one-signal':
        this.connector = new OneSignalPushConnector(config as ProviderConfigMap['one-signal'], customFetch);
        break;
      case 'pusher-beams':
        this.connector = new PusherBeamsPushConnector(config as ProviderConfigMap['pusher-beams'], customFetch);
        break;
      case 'wonderpush':
        this.connector = new WonderPushPushConnector(config as ProviderConfigMap['wonderpush'], customFetch);
        break;
      default:
        throw new ConnectorError({
          message: `Unsupported push provider: ${providerId as string}`,
          statusCode: null,
          providerCode: 'invalid_request',
        });
    }
  }

  async send(input: PushFacadeInput<P>): Promise<PushSendResult> {
    return this.connector.send(input as PushSendInput);
  }

  async checkIntegration(): Promise<{ success: boolean; message?: string }> {
    const c = this.connector as IPushConnector & {
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
