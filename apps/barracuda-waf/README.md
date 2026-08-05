# Barracuda WAF-as-a-Service (Veltrix app)

Manage **Barracuda WAF-as-a-Service** (Web Application Firewall) security
configuration as code through its native REST API (v4,
`api.waas.barracudanetworks.com`). Authoring happens in the Veltrix
Configuration Canvas; every change is applied by the Security-as-Code pipeline
(validate → deploy → health check → drift detect → rollback). Each
configuration type targets **one** WAF-as-a-Service Application, addressed by
the registered component's hostname.

> **Why WAF-as-a-Service, not Email Gateway Defense?** The original brief for
> this app targeted **Barracuda Email Gateway Defense** (EGD, formerly Email
> Security Service / Essentials) — filling an email-security gap in the
> catalog. EGD was evaluated first and did **not** clear the viability gate:
> its public REST API (`documentation.campus.barracuda.com/wiki/spaces/EGD/
> pages/2851445/Resources`, "Getting Started with the API") is a **beta**
> endpoint, region-limited to US/UK, exposing exactly three resources —
> **Accounts, Domains, Statistics** — with **only a single documented OAuth
> scope, `ess:account:read`** ("Allow read-only access to account
> information"). There is no write scope, no POST/PUT/PATCH/DELETE operation
> anywhere in the documented surface, and no endpoint for the actual policy
> objects (inbound/outbound filtering, sender/IP policy, ATP, encryption) —
> those remain UI-only, exactly the "thin, effectively read-only API" pattern
> that this catalog's *abnormal-security* candidate was rejected for. Building
> an EGD app would mean shipping a hollow shell with no genuine
> config-as-code write surface, which this catalog does not do.
>
> Barracuda **WAF-as-a-Service**, by contrast, has a mature, fully
> REST/OpenAPI-documented, actively-versioned (v4) API — self-described by
> Barracuda as "built API first... every configuration setting can be managed
> using APIs" — covering dozens of genuine, independently CRUD-able security
> resources per Application (Basic Security, IP Reputation, DDoS lists, Rate
> Control Pools, Header/Parameter/URL protection, Traffic Rules, Response
> Pages, and many more). It also fills a real gap in the catalog (no
> dedicated WAF app existed). This app was built against WAF-as-a-Service
> instead, per the documented pivot rule for exactly this situation.

## Configuration types

| Type | Manages | API | Reconciliation |
| --- | --- | --- | --- |
| **Basic Security** (`basic-security`) | The WAF engine's protection mode (Active enforces, Passive logs only) | `/applications/{appName}/basic_security/` (GET/PATCH/PUT) | Singleton; always declares the full managed state |
| **IP Reputation** (`ip-reputation`) | GeoIP/IP-reputation blocking (Tor, proxies, datacenters, attack sources, fake crawlers, blocked countries) and its IP exception list | `/applications/{appName}/ip_reputation/` (GET/PATCH/PUT) | Singleton; always declares the full managed state |
| **DDoS Allow List** (`ddos-allow-list`) | IP/CIDR entries exempted from the DDoS protection engine | `/applications/{appName}/ddos/allow_list/` (GET/POST list+create, PATCH/DELETE by server-assigned id) | Canvas is the complete desired allow list; reconciled by IP address (create/update/**remove** undeclared entries) |
| **Header Allow / Deny Rules** (`header-allow-deny`) | Named per-header attack-type blocking rules (SQLi, XSS, RFI, directory traversal, LDAP injection, ...; plain + strict severity per type) | `/applications/{appName}/headers_allow_deny/rules/` (GET/POST list+create, GET/PATCH/PUT/DELETE by rule name) | Canvas is the complete desired rule set; reconciled by rule name |
| **Parameter Protection** (`parameter-protection`) | Application-wide parameter value/length/instance limits, file-upload controls and per-attack-type settings | `/applications/{appName}/parameter_protection/` (GET/PATCH/PUT) | Singleton; always declares the full managed state |
| **URL Protection** (`url-protection`) | Application-wide allowed HTTP methods/content types, CSRF prevention, request/upload limits and per-attack-type settings | `/applications/{appName}/url_protection/` (GET/PATCH/PUT) | Singleton; always declares the full managed state |
| **Traffic Rules** (`traffic-rules`) | Named host/URL-match routing rules to backend Servers/Endpoints | `/applications/{appName}/traffic_rules/` (GET/POST list+create, GET/PUT/PATCH/DELETE by name) | Canvas is the complete desired rule list; reconciled by rule name |
| **Rate Control Pools** (`rate-control-pools`) | Named rate-control pools (max active requests / unconfigured clients / per-client backlog, optional preferred clients and URL scoping) | `/applications/{appName}/rate_control/pools/` (GET/POST list+create, GET/PUT/PATCH/DELETE by name) | Canvas is the complete desired pool set; reconciled by pool name |
| **Response Pages** (`response-pages`) | Named custom violation/error response pages (status code, headers, body) | `/applications/{appName}/response_page_component/pages/` (GET/POST list+create, GET/PATCH/PUT/DELETE by name) | Canvas is the complete desired page set; reconciled by page name |

## Authentication

Barracuda WAF-as-a-Service authenticates with a **Barracuda Cloud Control**
admin account. The account's email and password are exchanged for a
short-lived session token:

```
POST /api_login/  { email, password, account_id? }  ->  { key, expiry }
```

`key` is sent on every subsequent call as the `auth-api` header (not
`Authorization: Bearer`). This app's client (`lib/barracudaWaf.ts`) caches the
token per handler invocation and re-authenticates when it is within a minute
of expiry, or once on an unexpected `401`.

Store the credentials as a Veltrix connection (Username & password auth):

- **Admin email** (Username) → the admin account's full email address
- **Password** → the admin account password
- **Account ID (MSP, optional)** app setting → for a Barracuda partner/MSP
  account acting on behalf of a managed sub-account

## Setup

1. Create/identify a Barracuda Cloud Control admin account that can manage
   the target Application.
2. Add a connection with the admin email + password (Connections page), and
   run the connectivity test.
3. Register a **`barracuda-waf`** component whose hostname is the **exact
   Application name** shown under Applications in the WAF-as-a-Service
   console, and attach the credential. Register one component per Application
   you want to manage as code.

## Notes

- The API base URL is `https://api.waas.barracudanetworks.com/v4/waasapi`
  (overridable via the **API Base URL** app setting).
- List endpoints follow the account's Django REST Framework pagination
  (`{count, next, previous, results}`) when a collection is large; this app's
  client follows `next` to completion.
- The **DDoS Allow List**, **Header Allow/Deny Rules**, **Traffic Rules**,
  **Rate Control Pools** and **Response Pages** config types each **own** the
  full set of their resource on the Application: the canvas is the complete
  desired state, so an item removed from the canvas is deleted from Barracuda
  on the next deploy (not merely left alone). This mirrors how this codebase
  already treats Cloudflare's WAF custom rules.

## Development

```
cd apps/barracuda-waf
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs barracuda-waf         # run handler tests
node ../../scripts/validate-app.mjs apps/barracuda-waf # validate against the app contract
```

## Coverage (v0.1.0)

Coverage was audited against the live WAF-as-a-Service v4 OpenAPI document,
fetched directly from the running product at
`https://api.waas.barracudanetworks.com/v4/swagger/` (title "Barracuda
WAF-as-a-Service API Documentation", version 4.0.0; audited 2026-08-05),
corroborated by `documentation.campus.barracuda.com/wiki/display/WAFAAS/
WaaS+API+Version+4` ("Getting Started") and the public
`github.com/barracudanetworks/waf-automation` sample client. This is the
authoritative, current source.

### Managed declarative configuration

| Configuration type | WAF-as-a-Service API operations |
| --- | --- |
| Basic Security | get/PATCH/PUT `/applications/{appName}/basic_security/` |
| IP Reputation | get/PATCH/PUT `/applications/{appName}/ip_reputation/` |
| DDoS Allow List | list/create `/applications/{appName}/ddos/allow_list/`; update/delete `.../allow_list/{id}/` |
| Header Allow/Deny Rules | list/create `/applications/{appName}/headers_allow_deny/rules/`; get/update/delete `.../rules/{ruleName}/` |
| Parameter Protection | get/PATCH/PUT `/applications/{appName}/parameter_protection/` |
| URL Protection | get/PATCH/PUT `/applications/{appName}/url_protection/` |
| Traffic Rules | list/create `/applications/{appName}/traffic_rules/`; get/update/delete `.../traffic_rules/{name}` |
| Rate Control Pools | list/create `/applications/{appName}/rate_control/pools/`; get/update/delete `.../pools/{poolName}/` |
| Response Pages | list/create `/applications/{appName}/response_page_component/pages/`; get/update/delete `.../pages/{pageName}/` |

### Intentionally excluded

- **DDoS Block List** (`/applications/{appName}/ddos/block_list/`): the API
  exposes only `GET` (list, item) and `DELETE` for this resource — no
  `POST`/`PATCH` exists. Entries are populated by Barracuda's own DDoS
  detection engine, not authored by an administrator, so there is nothing
  genuinely declarative to manage; only the Allow List (full CRUD) is
  modeled.
- **Header Allow/Deny master toggle** (the parent singleton
  `/applications/{appName}/headers_allow_deny/`, wire shape `{rules: [...],
  enabled}`): this app manages the individual named rules under the nested
  `/rules/` collection (full CRUD, the genuinely declarative surface); the
  parent's own master `enabled` flag that gates the whole feature is not
  separately toggled by this config type.
- **Rate Control Pool nested sub-resources**
  (`.../pools/{poolName}/preferred_clients/{clientName}/`, `.../pools/
  {poolName}/urls/{urlName}/`): these exist as independently addressable REST
  resources, but this app manages them via the pool's own embedded
  `preferred_clients`/`urls` arrays (sent whole in the pool's PUT/POST body),
  keeping the config type at the pool level rather than adding two more
  deeply-nested config types for marginal benefit.
- **SNI Certificate / Trusted CA** (`/applications/{appName}/sni_certificate/`,
  `/applications/{appName}/trusted_ca/`): SNI certificates are documented as
  "currently only enabled for isolated mode customers" — a narrow deployment
  mode, not the general case — so this narrow-applicability surface is left
  for a future release rather than shipped as a config type most tenants
  cannot use.
- **Trusted Hosts** (`/applications/{appName}/trusted_hosts/`): an internal
  host allow-list (bypasses WAF inspection for trusted internal traffic);
  confirmed full CRUD via the live API but left for a future release to keep
  this initial release's scope to the highest-value security-policy surfaces
  (quality over count).
- **Applications/AppGroups themselves** (`/applications/` list-only in this
  API version's "App | Applications" tag; `/app_groups/` create+list; whole-
  Application config transfer via `/applications/{appName}/import/` and
  `/export/`): provisioning a new Application (its network topology — backend
  servers, public Endpoints/listeners, DNS, initial onboarding) is a
  materially different, higher-blast-radius problem than the per-Application
  security-policy surfaces above, and typically involves infrastructure
  (DNS, TLS/cert issuance) outside this platform's credential/component
  model. This app assumes the Application already exists (created via the
  WAF-as-a-Service console or the whole-app import endpoint) and is
  registered as a `barracuda-waf` component — matching how this codebase's
  Splunk/Security Onion apps do not provision the underlying appliance
  either.
- **Everything else under "Account" / "AppGroup"** (API Keys, Containers,
  Roles, SOAP/XML Validation, Account Settings, Datapath Options, Audit Logs,
  AppGroup Attackdef Settings, Container Image Version, Internal Patterns,
  Snapshots, Attack/Input Types, Custom Parameter Classes, Custom Identity
  Theft Type, DNS Zones, FUP Usage) and the remaining **~30 additional
  per-Application resources** this API exposes (App Profiles, Blocked Bots,
  Caching and Compression, Clickjacking Protection, Client Evaluation,
  Comment/Form/Referer Spam, Cookie Security, Data Theft Protection,
  Endpoints, Extra Data, JSON Security, JWT Validation, Load Balancing, LLM
  Security, Logs, Log Servers, Request Limits, Request/Response Rewrite,
  Response Cloaking, Sensitive Parameters, Servers, Slow Client Prevention,
  Tarpit Profile, URL Access and Redirects/Encryption/Normalization,
  Violation Responses, Web Scraping, Locked Out Client IPs/FPs, Suspicious
  IPs, XML Protection, Snapshot, Url Translation, CDN, Backend Connectivity
  Test, Troubleshooting Tools): all genuine, further config-as-code
  candidates for a future release (this is a very large API — see the
  "quality over count" note above); none were found to be read-only or
  action-only during this audit, so their omission here is purely a scoping
  decision for v0.1.0, not a viability finding.

Primary reference: the live WAF-as-a-Service v4 OpenAPI document (path
above), read directly via its rendered Swagger UI (the raw `swagger.json`
document is served behind the account's own bot/WAF challenge and could not
be fetched programmatically — every endpoint, method and example cited here
was confirmed by rendering and expanding the live documentation UI itself).
