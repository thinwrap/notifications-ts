import type { ProviderConfigMap, EmailProvider } from '../types';
import type {
  EmailSendInput,
  EmailSendResult,
  IEmailConnector,
} from '../types';
import type { EmailInputMap } from '../types/input-map.type';
import { ChannelTypeEnum } from '../types';
import { ConnectorError } from '../types';
import { SesEmailConnector } from '../providers/ses';
import { ResendEmailConnector } from '../providers/resend';
import { MailgunEmailConnector } from '../providers/mailgun';
import { SendgridEmailConnector } from '../providers/sendgrid';
import { PostmarkEmailConnector } from '../providers/postmark';
import { MailerSendEmailConnector } from '../providers/mailersend';
import { MailtrapEmailConnector } from '../providers/mailtrap';
import { BrevoEmailConnector } from '../providers/brevo';
import { SparkPostEmailConnector } from '../providers/sparkpost';
import { ScalewayEmailConnector } from '../providers/scaleway';

type EmailFacadeInput<P extends EmailProvider> = P extends keyof EmailInputMap
  ? EmailInputMap[P]
  : EmailSendInput;

type EmailConfigWithFetch<P extends EmailProvider> = ProviderConfigMap[P] & {
  fetch?: typeof fetch;
};

export class Email<P extends EmailProvider = EmailProvider> {
  public readonly id: string;
  public readonly channelType = ChannelTypeEnum.EMAIL;
  private readonly connector: IEmailConnector;

  constructor(providerId: P, config: EmailConfigWithFetch<P>);
  constructor(connector: IEmailConnector);
  constructor(arg: P | IEmailConnector, config?: EmailConfigWithFetch<P>) {
    if (typeof arg === 'object' && arg !== null) {
      this.id = arg.id;
      this.connector = arg;
      return;
    }
    if (!config) {
      throw new ConnectorError({
        message: 'Email facade requires `config` when constructed with a provider id',
        statusCode: null,
        providerCode: 'invalid_request',
      });
    }
    const providerId = arg;
    this.id = providerId;
    const customFetch = config.fetch;
    switch (providerId) {
      case 'ses':
        this.connector = new SesEmailConnector(config as ProviderConfigMap['ses'], customFetch);
        break;
      case 'resend':
        this.connector = new ResendEmailConnector(config as ProviderConfigMap['resend'], customFetch);
        break;
      case 'mailgun':
        this.connector = new MailgunEmailConnector(config as ProviderConfigMap['mailgun'], customFetch);
        break;
      case 'sendgrid':
        this.connector = new SendgridEmailConnector(config as ProviderConfigMap['sendgrid'], customFetch);
        break;
      case 'postmark':
        this.connector = new PostmarkEmailConnector(config as ProviderConfigMap['postmark'], customFetch);
        break;
      case 'mailersend':
        this.connector = new MailerSendEmailConnector(config as ProviderConfigMap['mailersend'], customFetch);
        break;
      case 'mailtrap':
        this.connector = new MailtrapEmailConnector(config as ProviderConfigMap['mailtrap'], customFetch);
        break;
      case 'brevo':
        this.connector = new BrevoEmailConnector(config as ProviderConfigMap['brevo'], customFetch);
        break;
      case 'sparkpost':
        this.connector = new SparkPostEmailConnector(config as ProviderConfigMap['sparkpost'], customFetch);
        break;
      case 'scaleway':
        this.connector = new ScalewayEmailConnector(config as ProviderConfigMap['scaleway'], customFetch);
        break;
      default:
        throw new ConnectorError({
          message: `Unsupported email provider: ${providerId as string}`,
          statusCode: null,
          providerCode: 'invalid_request',
        });
    }
  }

  async send(input: EmailFacadeInput<P>): Promise<EmailSendResult> {
    return this.connector.send(input as EmailSendInput);
  }

  async checkIntegration(): Promise<{ success: boolean; message?: string }> {
    const c = this.connector as IEmailConnector & {
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
