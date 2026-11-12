# Microsoft Entra ID authentication and tenant targeting

Version 0.9.0 keeps existing client-secret connections working and adds certificate assertions, optional platform-broker tokens, cloud selection, and tenant overrides keyed by saved credential ID. Every handler, picker, connection test, and rollback resolves credentials through the same Graph client.

## Credential formats

| Method | Vault fields | Prerequisite |
| --- | --- | --- |
| Client secret | Username = Application ID; Password or API token = secret Value | Application permissions and tenant admin consent |
| Certificate | Username = Application ID; Certificate = PEM certificate followed by its matching PEM private key | Upload the public certificate to the Entra app registration |
| Platform broker | A saved connection carrying the host's identity broker; no app-held secret or certificate | The platform administrator must configure a brokered connector and its consent flow |

Client-secret connections created by either the shared UI's Password or Client secret/token method are accepted. Certificate and private-key material belongs in the encrypted vault certificate field, not app settings. Encrypted private keys requiring a passphrase are not supported by this format.

Certificate authentication signs a five-minute PS256 client assertion with a fresh JWT ID, a SHA-256 certificate thumbprint, and the selected tenant's token endpoint as audience. See [Microsoft certificate credentials](https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials).

Brokered authentication calls the SDK identity broker with the effective tenant, Graph audience, and cloud. The host owns its token exchange and credential lifecycle. This app does not provision a managed identity or platform connector; the host must supply a supported broker. Delegated user authentication remains outside this app's contract, so Terms of Use agreement management is blocked before network access.

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

Use the saved credential's ID, not its label or the directory's ID, as the map key. An unmapped credential retains the installation defaults. An invalid mapping fails credential resolution rather than silently using the fallback tenant. Every Graph client holds its own token state; credentials from separate connections do not share a token cache.

Keep a connection's tenant/cloud binding unchanged between deployment and rollback. Rollback IDs and snapshots belong to the tenant where the deployment ran.

## Migrate existing installations

1. Keep the existing Tenant ID and global cloud setting. The default empty override object preserves legacy behavior.
2. Record each existing credential ID and its verified tenant. Before changing installation defaults or adding another tenant, bind the existing credential IDs explicitly in the override object.
3. Add the new tenant's credential and explicit override. Use Test to verify the returned organization identity, then check the selected feature read endpoints.
4. Validate a configuration with the intended target selected. Test report-only changes and rollback in a sandbox before production use.
5. For secret-to-certificate rotation, configure the public certificate in Entra, update the vault credential, verify the connection and a selected feature, then revoke the old secret.

If a host supplies a brokered connection, confirm the host adapter's cloud names, tenant binding, consent permissions, and token audience in its integration environment before switching an existing deployment to that connection.

## Mutation recovery

Read transport failures may retry once. A mutation transport failure reports an uncertain outcome and is not blindly retried. Check live objects and the deployment's recorded identities before resubmitting; a lost response can follow a committed write. Reconciliation refuses incomplete listings and ambiguous target names. Keep the prior deployment and rollback information until recovery is complete.
