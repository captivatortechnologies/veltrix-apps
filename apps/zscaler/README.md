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
sandbox, web DLP, forwarding control. Objects: URL categories, network services / service groups /
application groups, IP source / destination groups, DLP dictionaries / engines / notification
templates. Connectivity: locations, VPN credentials, GRE tunnels, static IPs. Admin: roles, users, rule
labels.

### Zscaler Private Access (ZPA)

Application segments, segment groups, server groups, servers, app connector groups, service edge
groups, provisioning keys, and access/timeout/forwarding/inspection/isolation policy rules.

## Coverage

33 configuration types across ZIA and ZPA. See each type's `description` in `manifest.yaml` for its
exact endpoint.

### Managed

**ZIA · Policy Rules** — `/urlFilteringRules`, `/firewallFilteringRules`, `/firewallDnsRules`,
`/firewallIpsRules`, `/sslInspectionRules`, `/fileTypeRules`, `/sandboxRules`, `/webDlpRules`,
`/forwardingRules` (direct / proxy-chain / ZPA-forward / drop).

**ZIA · Objects & Groups** — custom URL categories (`/urlCategories`), network services / service
groups / application groups, IP source / destination groups, rule labels.

**ZIA · DLP** — custom DLP dictionaries, DLP engines, DLP notification templates.

**ZIA · Traffic Forwarding** — locations, VPN credentials, GRE tunnels, static IPs.

**ZIA · Administration** — admin roles, admin users.

**ZPA · Infrastructure** — app connector groups, service edge groups, servers, server groups,
provisioning keys.

**ZPA · Applications & Policy** — segment groups, application segments, and access / timeout /
forwarding / inspection / isolation policy rules (the `policySet` model).

### Intentionally not managed

- **Activation** (`POST /status/activate`) — a one-shot batch action, not a declarative object; every
  ZIA deploy handler already calls it once after writing all staged changes (see "Zscaler-specific
  behaviour" above), so it is never itself a config type.
- **Predefined / built-in objects** — predefined URL categories, predefined network services, built-in
  DLP dictionaries/engines, built-in admin roles, and each policy's default/protected rule (e.g. the ZIA
  default firewall rule, or ZPA/ZIA's predefined forwarding rules such as "ZPA Pool For Stray Traffic")
  — read-only baselines the API itself refuses to let you modify or delete. Every rule/object deploy
  handler detects and refuses to touch them.
- **Write-only secrets** — ZIA VPN pre-shared keys and admin passwords, and ZPA provisioning-key
  values. The API never returns these on GET, so there is nothing to diff; they are supplied on write
  only and excluded from drift detection by design.
- **Sandbox file submission** — Zscaler's "submit a file for sandbox analysis" action is a one-shot
  operation on a file, not a declarative object; this app manages the sandbox *policy rules*
  (`/sandboxRules`) that route traffic to the sandbox, not file submission itself.
- **CASB DLP / malware rules** (`resource_zia_casb_dlp_rules`, `resource_zia_casb_malware_rules` in
  [terraform-provider-zia](https://github.com/zscaler/terraform-provider-zia)) — part of Zscaler's SaaS
  Security Posture Management (CASB) module, a separate add-on license from the core ZIA web/DLP
  policy this app manages.
- **Endpoint DLP** (`resource_zia_endpoint_dlp_rules` and related) — Zscaler Client Connector-based
  endpoint DLP, a separate add-on module from the web DLP rules (`/webDlpRules`) already covered.
- **NSS / Cloud NSS servers** (`resource_zia_nss_server`, `resource_zia_cloud_nss_server`) — SIEM
  log-streaming feed configuration, not security policy.
- **ZIA tenant-wide singleton settings** — Advanced Settings, ATP (malware/URL) settings, Auth Exempt
  URLs, Browser Control Policy, FTP Control Policy, Mobile Malware Protection, DLP Global Options, End
  User Notification, and Bandwidth Classes/Control Rules are all `GET`+`PUT` singleton resources (one
  tenant-wide object, not a list of named rules). They are a legitimate future surface but out of scope
  for this pass, which targets the per-object policy rules and objects Zscaler documents as the core ZIA
  configuration surface.
- **Cloud App Control Rules** (`resource_zia_cloud_app_control_rules`, endpoint keyed by a `ruleType`
  path segment across ~20 SaaS-application categories, e.g. Webmail/Social Networking/File Share) — a
  real, currently-unmanaged ZIA policy, but its multi-dimensional per-category API shape (list/create
  dispatch by `ruleType`, not a single flat collection) warrants its own dedicated pass rather than
  folding into this one.
- **Cloud & Branch Connector / Edge Connector resources** (DNAT/SNAT/`EC_*` forwarding rule types, VZEN
  cluster/nodes, sub-clouds, extranet) — Zscaler's branch/edge-connector virtual-appliance product line,
  a distinct deployment model from the pure cloud ZIA/ZPA policy this app targets.
- **ZPA Privileged Remote Access, Browser/Cloud Isolation, and LSS log streaming** (PRA
  consoles/credentials/portals, isolation profiles, `resource_zpa_lss_config_controller`) — separate ZPA
  add-on modules beyond the core application-access surface (segments/groups/servers/connectors/policy)
  this app manages.
- **ZIA end-user accounts** (`/users`) — Zscaler's end-user directory is typically synced from an IdP via
  SCIM rather than declared as code; this app manages **admin** accounts and roles (`/adminUsers`,
  `/adminRoles`), which are the accounts that operate the tenant itself.

## Zscaler-specific behaviour the app handles

- **ZIA stages changes; ZPA is immediate.** Every ZIA write is *staged* and takes effect only after
  activation. ZIA deploys therefore write every object and then call `POST /status/activate`
  **once**; rollbacks revert and re-activate once. ZPA changes apply immediately — no activation step.
- **Identity survives environments.** Objects key on their **name** (ZIA assigns numeric ids, ZPA
  string ids; URL categories use string ids). There is no upsert — the app lists, matches by name, then
  creates or updates.
- **Predefined / built-in objects are never modified or deleted**: predefined URL categories, network
  services, DLP dictionaries/engines, built-in admin roles, each policy's default/catch-all rule, and
  ZIA's predefined forwarding control rules (e.g. "ZPA Pool For Stray Traffic") — matched by name, since
  that resource returns no `predefined` flag.
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
