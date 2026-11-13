# Microsoft Entra ID authentication and tenant targeting

Version 0.11.0 adds Microsoft OAuth/OpenID Connect onboarding alongside existing manual secret/certificate connections, cloud selection and per-credential tenant bindings. Every handler, picker, connection test, and rollback resolves credentials through the same Graph client.

## Credential formats

| Method | Vault fields | Prerequisite |
| --- | --- | --- |
| Client secret | Username = Application ID; Password or API token = secret Value | Application permissions and tenant admin consent |
| Certificate | Username = Application ID; Certificate = PEM certificate followed by its matching PEM private key | Upload the public certificate to the Entra app registration |
| Microsoft OAuth/OIDC | Created by Integrate with Microsoft (OAuth); no customer secret | Platform connector registered; active Global Administrator or Privileged Role Administrator |

Client-secret connections created by either the shared UI's Password or Client secret/token method are accepted. Certificate and private-key material belongs in the encrypted vault certificate field, not app settings. Encrypted private keys requiring a passphrase are not supported by this format.

Certificate authentication signs a five-minute PS256 client assertion with a fresh JWT ID, a SHA-256 certificate thumbprint, and the selected tenant's token endpoint as audience. See [Microsoft certificate credentials](https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials).

Brokered authentication calls the SDK identity broker with the effective tenant, Graph audience and cloud. The broker verifies the saved credential belongs to the current Veltrix customer, the app, and a consented directory/cloud before returning a token, including when a token is cached. Deploy, rollback, health, drift, options, connection tests and operations receive the same tenant settings and credential-bound broker. Delegated-only Graph actions, including Terms of Use agreement management, remain blocked.

## Platform connector setup

A platform administrator performs these steps once for each Microsoft cloud used:

1. Create a platform-owned Entra application registration with **Accounts in any organizational directory**. Each national cloud needs its own registration. Use the matching Entra portal and authority.
2. Add a **Web** redirect URI matching the exact static callback displayed in **Platform Admin > Cloud Integrations > Settings > Connector apps**. It ends in `/api/apps/connections/onboard/callback`; use the displayed public URL, including its scheme and host.
3. In the Entra registration manifest, set `groupMembershipClaims` to `DirectoryRole` so the signed ID token includes the administrator's `wids` roles. Activate eligible privileged roles before signing in. Global Administrator and Privileged Role Administrator are supported for granting Microsoft Graph application permissions.
4. Configure the Microsoft Graph **Application** permissions for the selected features. `Organization.Read.All` is the minimum connection-test profile. Use the capability table for additional feature permissions. The customer will approve the permissions actually configured on this registration; the app's descriptor does not dynamically reduce that grant. Enable the standard OpenID Connect `openid profile` sign-in scopes; no delegated Graph access or refresh token is used for background operations.
5. Create the platform connector credential, then register it in **Connector apps** under **Microsoft Entra OAuth / OpenID Connect** (`entra-oidc-consent`), scoped to `microsoft-entra-id` and the chosen cloud. Enter its Application ID and secret in that platform-only form. The secret is encrypted and never returned to tenants. Prefer an app-specific registration for least privilege.
6. Verify the registered callback URL, consent in a sandbox through Connections, then run Test, a selected read/report, and an approved pilot deployment/rollback. Rotate the central secret through the same platform-only form before expiry.

The flow uses OAuth authorization code with S256 PKCE and a server nonce to verify an OIDC ID token's signature, issuer, audience, expiry, directory and administrator role. It then issues a separate one-time state for tenant-specific admin consent. The consent callback must match the verified directory before a saved connection is created. Authorization codes, ID tokens and platform secrets do not enter canvas settings or connection results.

See [Microsoft admin consent](https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent), [OpenID Connect](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc), and [directory role claims](https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-fed-group-claims).

## Consent, reconnect and removal

Connecting another directory atomically adds its verified tenant/cloud under the new credential ID in `connection_tenants`; it does not replace the installation fallback or existing connection bindings. Keep those bindings unchanged for deployment and rollback. A mismatched or removed binding cannot authorize a token for a different directory.

After permissions change, repeat OAuth consent as an authorized administrator and test the replacement connection before moving targets. Deleting the saved connection prevents its broker from returning tokens; it does not by itself remove all consent in Microsoft. Remove the enterprise application's permissions in Entra when access is no longer needed, accounting for other connections using that same registration and directory.

If onboarding fails while saving its tenant binding, the newly created local credential is removed. Review the error, correct the settings or connector registration, and restart the flow; one-time callback states cannot be replayed.

## Cloud selection

Set **Microsoft cloud** (`azure_cloud`) to one of these values. No arbitrary authority or Graph URL is accepted.

| Value | Authority | Graph audience |
| --- | --- | --- |
| global | https://login.microsoftonline.com | https://graph.microsoft.com |
| us-gov | https://login.microsoftonline.us | https://graph.microsoft.us |
| us-gov-dod | https://login.microsoftonline.us | https://dod-graph.microsoft.us |
| china | https://login.chinacloudapi.cn | https://microsoftgraph.chinacloudapi.cn |

The token scope is the selected Graph audience plus `/.default`. Requests and pagination remain within that audience's `/v1.0/` API, redirects are refused, and Graph `@odata.id` references use the same cloud. A selected cloud does not establish that every API or license is available there. See [Microsoft national clouds](https://learn.microsoft.com/en-us/entra/identity-platform/authentication-national-cloud).

## Per-connection tenants

**Tenant ID** (`tenant_id`) and **Microsoft cloud** are installation fallbacks. **Per-connection tenant overrides** (`connection_tenants`) is a JSON object keyed by the credential ID associated with a connection:

```json
{
  "saved-credential-id-a": { "tenantId": "directory-guid-a", "cloud": "global" },
  "saved-credential-id-b": { "tenantId": "directory-guid-b", "cloud": "us-gov" }
}
```

Use the saved credential's ID, not its label or the directory's ID, as the map key. An unmapped manual credential retains the installation defaults. OAuth-created credentials receive a verified per-connection entry automatically. An invalid mapping fails credential resolution rather than silently using the fallback tenant. Every Graph client holds its own token state; credentials from separate connections do not share a token cache.

Keep a connection's tenant/cloud binding unchanged between deployment and rollback. Rollback IDs and snapshots belong to the tenant where the deployment ran.

## Migrate existing installations

1. Keep the existing Tenant ID and global cloud setting. The default empty override object preserves legacy behavior.
2. Record each existing credential ID and its verified tenant. Before changing installation defaults or adding another tenant, bind the existing credential IDs explicitly in the override object.
3. Add the new tenant's credential and explicit override. Use Test to verify the returned organization identity, then check the selected feature read endpoints.
4. Validate a configuration with the intended target selected. Test report-only changes and rollback in a sandbox before production use.
5. For secret-to-certificate rotation, configure the public certificate in Entra, update the vault credential, verify the connection and a selected feature, then revoke the old secret.

For manual-to-OAuth migration, create and test the OAuth connection first, select its target for a pilot deployment, and retire the old credential only after successful rollback and feature checks. The existing manual credential is not modified by OAuth onboarding.

## Mutation recovery

Read transport failures may retry once. A mutation transport failure reports an uncertain outcome and is not blindly retried. Check live objects and the deployment's recorded identities before resubmitting; a lost response can follow a committed write. Reconciliation refuses incomplete listings and ambiguous target names. Keep the prior deployment and rollback information until recovery is complete.
