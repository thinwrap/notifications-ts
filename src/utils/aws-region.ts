import { ConnectorError } from '../types/error.types';

// botocore `utils.validate_region_name`: `^(?![0-9]+$)(?!-)[a-zA-Z0-9-]{,63}(?<!-)$`,
// tightened to require at least one character.
const AWS_REGION_NAME = /^(?![0-9]+$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$/;

/**
 * Reject a region that is not a single hostname label. The region is
 * interpolated into the host (`<service>.<region>.amazonaws.com`) that the
 * SigV4 signature and any session token are sent to, so a value such as
 * `x.evil.example/` would redirect the credentials. Checked the way botocore
 * checks it, before any request is signed.
 */
export function assertAwsRegion(region: unknown, service: string): void {
  if (typeof region === 'string' && AWS_REGION_NAME.test(region)) return;
  const message = `${service} region must be an AWS region name such as "us-east-1".`;
  throw new ConnectorError({
    message,
    statusCode: null,
    providerCode: 'invalid_request',
    providerMessage: message,
  });
}
