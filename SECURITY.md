# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | yes                |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email security reports to: **security@thinwrap.dev**

Include:

- A description of the vulnerability.
- Steps to reproduce (proof-of-concept if possible).
- Affected versions.
- Suggested fix or mitigation (if known).

Expect an initial acknowledgement within **72 hours**. We aim to publish a
fix within **14 days** of confirmation for high-severity issues. We will
coordinate disclosure with you; please give us a reasonable window to patch
and release before public disclosure.

## Supply-chain integrity

Releases are published to npm via GitHub Actions OIDC trusted-publishing with
**Sigstore provenance attestation**. Verify any installed copy:

```bash
npm audit signatures @thinwrap/notifications@<version>
```

No long-lived npm publish token sits in this repository or its CI secrets
(per the umbrella org's supply-chain hardening policy).

This repo's CI is self-contained — it consumes no external reusable
workflows, so there is no third-party-workflow supply-chain surface in its
publish flow.

## Two-factor authentication

The npm account authorized to publish `@thinwrap/notifications` is configured
with two-factor authentication via an authenticator app (TOTP), with npm's
`auth-and-writes` setting enabled. Combined with OIDC, publish privilege
requires both a passing release-tag GitHub Actions run AND a 2FA challenge.

## Out-of-scope

- Vulnerabilities in vendor APIs (SendGrid, Mailgun, Twilio, Vonage, Amazon
  SES/SNS, FCM, APNs, Slack, Discord, Telegram, …) themselves — report those
  to the respective vendors. This package is a thin wrapper and does not
  modify or proxy vendor responses beyond documented normalization.
- Issues only reproducible by running with a threat model that this wrapper
  is meant to enforce lifted — the wrapper performs no automatic retry and
  holds no state; consumers compose their own policies.
