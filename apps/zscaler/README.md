# Zscaler

Manage [Zscaler](https://www.zscaler.com/) Internet Access (**ZIA**) and Private Access (**ZPA**)
configuration as code through the **Zscaler OneAPI**. Author configurations in the platform's
Configuration Canvas and deploy them through the Security-as-Code pipeline — validate, deploy, health
check, drift detection and rollback are handled per configuration type.

## One API, two products

The Zscaler OneAPI unifies ZIA and ZPA behind a single OAuth2 credential. A OneAPI token authenticates
both; calls are routed to one host by path prefix:

- **ZIA** — `https://api.zsapi.net/zia/api/v1/...`
- **ZPA** — `https://api.zsapi.net/zpa/mgmtconfig/v1/admin/customers/{customerId}/...`

## Credentials

Create an **API client** in the Zidentity Admin portal (client-credentials grant) and grant it the
ZIA/ZPA roles for what this app manages. Store it as a Veltrix credential:

| Veltrix credential field | Zscaler value |
| --- | --- |
| Username | The API client **Client ID** |
| API token | The API client **Client Secret** |

The app exchanges these for a bearer token at `https://<vanity>.zslogin.net/oauth2/v1/token` (audience
`https://api.zscaler.com`) and caches it until expiry.

Register a **`zscaler-tenant`** component whose hostname is your **Zidentity vanity domain** (the tenant
subdomain, e.g. `acme`) and attach the credential. Configure the app settings:

- **Cloud** — leave blank for commercial production (`api.zsapi.net`); `gov`/`govus` for government
  clouds, or a named non-prod cloud (e.g. `beta`).
- **ZPA Customer ID** — required for every ZPA configuration type (ZPA Admin Portal →
  Configuration & Control → Public API → API Keys). ZIA-only deployments can leave it blank.
- **ZPA Microtenant ID** — optional, scopes ZPA config to a single microtenant.

## What it manages

### Zscaler Internet Access (ZIA)

Policy: URL filtering, cloud firewall (filtering / DNS / IPS), SSL inspection, file-type control,
sandbox, web DLP. Objects: URL categories, network services / service groups / application groups, IP
source / destination groups, DLP dictionaries / engines / notification templates. Connectivity:
locations, VPN credentials, GRE tunnels, static IPs. Admin: roles, users, rule labels.

### Zscaler Private Access (ZPA)

Application segments, segment groups, server groups, servers, app connector groups, service edge
groups, provisioning keys, and access/timeout/forwarding/inspection/isolation policy rules.

## Zscaler-specific behaviour the app handles

- **ZIA stages changes; ZPA is immediate.** Every ZIA write is *staged* and takes effect only after
  activation. ZIA deploys therefore write every object and then call `POST /status/activate`
  **once**; rollbacks revert and re-activate once. ZPA changes apply immediately — no activation step.
- **Identity survives environments.** Objects key on their **name** (ZIA assigns numeric ids, ZPA
  string ids; URL categories use string ids). There is no upsert — the app lists, matches by name, then
  creates or updates.
- **Predefined / built-in objects are never modified or deleted**: predefined URL categories, network
  services, DLP dictionaries/engines, built-in admin roles, and each policy's default/catch-all rule.
- **Write-only secrets are never diffed**: ZIA VPN pre-shared keys and admin passwords, and ZPA
  provisioning-key values — supplied on write, never read back into drift.
- **Dependency ordering on ZPA**: a server group references app connector groups; an application
  segment references a segment group and server groups; a provisioning key references an enrollment
  cert and its target group. The app resolves those references by name and fails clearly if a
  dependency is missing.
- The large, type-specific parts (policy-rule criteria, ZPA policy conditions, location options) are
  authored as JSON in the canvas.

## Health check

Handlers make a cheap authenticated read against the relevant product (ZIA activation status; a ZPA
paged list) to prove the credential works before doing any work, then confirm each declared object is
present.

## References

- Zscaler OneAPI: <https://help.zscaler.com/oneapi/understanding-oneapi>
- OneAPI authentication: <https://help.zscaler.com/zidentity/understanding-oneapi-authentication>
- ZIA API: <https://help.zscaler.com/zia/api>
- ZIA activation: <https://help.zscaler.com/zia/activation>
- ZPA API: <https://help.zscaler.com/zpa/understanding-zpa-api>
