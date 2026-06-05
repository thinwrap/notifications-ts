import type { CheckIntegrationResponseEnum } from './channel.enum';

export interface ISendMessageSuccessResponse {
  id?: string;
  ids?: string[];
  date?: string;
}

export interface ICheckIntegrationResponse {
  success: boolean;
  message: string;
  code: CheckIntegrationResponseEnum;
}
