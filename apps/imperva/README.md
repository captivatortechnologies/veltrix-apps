# Imperva

Manage **Imperva Cloud WAF** (formerly **Incapsula**) edge security as code.
Author site security / ACL rules, delivery / rewrite rules, data centers and
origin servers, per-rule exceptions, and general site configuration — and drive
them through the Veltrix Security-as-Code pipeline: **validate → deploy →
health check → drift detect → rollback**.

- **Category:** NETWORK
- **Config types:** ACL Rules (`acl-rules`) · Security Rules (`security-rules`)
  · ACL Configuration (`acl-configuration`) · Delivery Rules (`delivery-rules`)
  · Data Centers (`data-centers`) · Security Rule Exceptions
  (`security-rule-exceptions`) · Site Configuration (`site-configuration`)
- **API:** legacy Cloud WAF (Incapsula) management API **v1** —
  `https://my.imperva.com/api/prov/v1`
- **Auth:** an `api_id` + `api_key` pair, sent as POST form parameters
- **No database / no BYOL** — this app is API-driven only.

## What it manages

### ACL Rules (`config-types/acl-rules`)

One Imperva **IncapRule** of the security kind per canvas item. Fields:

| Field     | Notes                                                                                   |
| --------- | --------------------------------------------------------------------------------------- |
| `siteId`  | Numeric Cloud WAF site ID the rule protects. The rule name is unique within this site.  |
| `name`    | Rule name — the stable identity used for upsert + drift (within the site).              |
| `action`  | One of the security actions (block / alert / challenge — see below).                    |
| `filter`  | The ACL condition, e.g. `ClientIP == "203.0.113.7"`, `CountryCode == "CN"`, `Full-URL contains "/admin"`. Empty ⇒ the action runs on every request. |
| `enabled` | Whether Imperva enforces the rule.                                                      |

**Supported security actions:** `RULE_ACTION_BLOCK` (block request),
`RULE_ACTION_ALERT` (log only), `RULE_ACTION_BLOCK_USER` (block session),
`RULE_ACTION_BLOCK_IP` (block IP), `RULE_ACTION_RETRY` (require cookie support),
`RULE_ACTION_INTRUSIVE_HTML` (require JavaScript support), `RULE_ACTION_CAPTCHA`
(CAPTCHA challenge).

Handlers map onto the v1 IncapRules endpoints:

| Handler       | Imperva v1 call                                                        |
| ------------- | ---------------------------------------------------------------------- |
| `deploy`      | `POST /sites/incapRules/list` (identity) → `.../add` or `.../edit`     |
| `rollback`    | `POST /sites/incapRules/edit` (restore) or `.../delete` (created rule) |
| `driftDetect` | `POST /sites/incapRules/list` (compare action / filter / enabled)      |
| `healthCheck` | `POST /account`                                                        |
| `getStatus`   | platform deployment records                                            |

Rules are **upserted by name within a site** — a rule that already exists (same
name, same `siteId`) is edited; a new one is created. Rollback restores the prior
rule body, or deletes a rule this deploy created.

### Delivery Rules (`config-types/delivery-rules`)

The **same IncapRule resource** as ACL Rules (same v1 endpoints, same
upsert-by-name-within-a-site identity) — but authoring the **delivery / rewrite
/ rate / custom-error** subset of `action` values instead of the security
subset: `RULE_ACTION_REDIRECT`, `_SIMPLIFIED_REDIRECT`, `_REWRITE_URL`,
`_REWRITE_HEADER`, `_REWRITE_COOKIE`, `_DELETE_HEADER`, `_DELETE_COOKIE`,
`_RESPONSE_REWRITE_HEADER`, `_RESPONSE_DELETE_HEADER`,
`_RESPONSE_REWRITE_RESPONSE_CODE`, `_FORWARD_TO_DC`, `_FORWARD_TO_PORT`,
`_RATE`, `_CUSTOM_ERROR_RESPONSE`. Each action reveals only the fields it needs
(`from`/`to`, `rewrite_name`, `dc_id`, `rate_context`/`rate_interval`,
`error_type`/`error_response_format`/`error_response_data`, ...). **Not** the
same thing as Imperva's newer `incapsula_delivery_rules_configuration`
resource — that is a separate v3 API this app stays out of.

### Data Centers (`config-types/data-centers`)

One **data center** (origin server pool) per canvas item — identity is its
**name within a site** — with its **origin servers** as a JSON list (identity:
**address within the data center**). `POST /sites/dataCenters/{add,edit,delete,
list}` manages the pool; `POST /sites/dataCenters/servers/{add,edit,delete}`
manages individual servers. Creating a data center creates it together with its
first server in one call; deploy then converges that first server's
standby/enabled flags with a follow-up edit (the create call has no way to set
them), and reconciles any additional declared servers by address (add missing,
edit changed, delete removed).

### Security Rule Exceptions (`config-types/security-rule-exceptions`)

Lets specific traffic (by IP, country/continent, URL, user agent, client
app/app type, or request parameter) **bypass one security or ACL rule** on a
site — narrower than ACL Configuration's site-wide blacklist. `POST
/sites/configure/whitelists` adds/edits/deletes; `POST /sites/status` reads the
live set back. An exception has **no operator-facing name** (Imperva assigns
only a `whitelist_id` on create), so this config type reconciles by **content**
within each declared (site, rule) group — the match condition itself is the
identity — rather than tearing down and recreating every exception on every
deploy.

### Site Configuration (`config-types/site-configuration`)

A site's **general settings** as a declarative singleton per site: active/
bypass, domain validation method + approver email, ignore-SSL, acceleration
level, trust seal placement, restricted CNAME reuse, domain-redirect-to-full,
naked-domain/wildcard SAN, your own reference ID, and log level. `POST
/sites/configure` sets one `{ param, value }` pair per call (mirroring
Imperva's own Terraform provider); `POST /sites/setlog` sets the log level. An
empty field is **left untouched**, never cleared. Four fields — domain
validation, approver, ignore-SSL, domain-redirect-to-full — are **write-only**
on this API (no read-back on `/sites/status`): deploy can set them, but drift
detection can't compare them and rollback can't restore them, which this config
type surfaces explicitly. `remove_ssl` is deliberately **not** modeled — unlike
every other setting here it reads as a one-shot destructive action, not durable
state.

## Connecting

1. In the **Imperva Cloud Security Console → Account → API Keys**, create an API
   key with permission to manage site security (IncapRules). You receive an **API
   ID** and an **API key**.
2. On the app's **Connections** page, store the **API ID** as the credential
   username and the **API key** as the credential API token. Leave the endpoint
   blank to use the default (`https://my.imperva.com/api/prov/v1`), or set it to
   override the management host.
3. **Test** the connection (POST `/account`) and start authoring in the
   Configuration Canvas.

## Auth: legacy v1 vs the newer platform

This app targets the **legacy Cloud WAF (Incapsula) v1** API
(`https://my.imperva.com/api/prov/v1`, `api_id` + `api_key` as POST parameters)
because it is the confirmed writable surface for IncapRules (site security / ACL
rules). The **newer** Imperva platform (`https://api.imperva.com`, `x-API-Id` /
`x-API-Key` **headers**) is a separate surface and is not used here.

## Coverage (v0.3.0)

Coverage was audited against Imperva's **official open-source Terraform
provider** (`github.com/imperva/terraform-provider-incapsula` — every
`client_*.go` / `resource_*.go` file, its `website/docs/r/*.markdown` worked
examples, and its `provider.go` base-URL wiring), which distinguishes FOUR
underlying API surfaces by base URL: `BaseURL` (`/api/prov/v1`, the **legacy**
surface this app targets exclusively), `BaseURLRev2` (`/api/prov/v2`),
`BaseURLRev3` (`/api/prov/v3`), and `BaseURLAPI` (`api.imperva.com`, the newer
REST platform). Every resource in the provider is classified below as
**managed** (a config type in this app writes it, over v1 only) or **excluded**
(with the reason — most commonly "not on v1").

### Managed declarative configuration (all over the legacy v1 API)

| Configuration type | Imperva v1 API operations |
| --- | --- |
| ACL Rules | `POST /sites/incapRules/{add,edit,delete,list}` — security actions, upsert by name within a site |
| Security Rules | `POST /sites/configure/security` (+ read via `/sites/status`) — SQLi/XSS/RFI/illegal-resource/backdoor action, DDoS, bot access control; singleton per (site, rule) |
| ACL Configuration | `POST /sites/configure/acl` (+ read via `/sites/status`) — blacklist IPs/countries/URLs, whitelist IPs; singleton per (site, ACL type), whole-list replace |
| Delivery Rules | `POST /sites/incapRules/{add,edit,delete,list}` — SAME endpoint as ACL Rules, delivery/rewrite/rate/custom-error actions |
| Data Centers | `POST /sites/dataCenters/{add,edit,delete,list}` + `POST /sites/dataCenters/servers/{add,edit,delete}` |
| Security Rule Exceptions | `POST /sites/configure/whitelists` (+ read via `/sites/status`) — reconciled by content, no operator-facing name |
| Site Configuration | `POST /sites/configure` (one param/value pair per call) + `POST /sites/setlog` |

### Notable implementation details, verified against the provider source

- **Delivery Rules and ACL Rules are the SAME resource.** Imperva's own
  provider currently talks to a newer `BaseURLRev2` JSON endpoint
  (`/sites/{siteId}/rules`) for `incap_rule`, but the OLDER `BaseURL` form
  endpoint (`/sites/incapRules/add`) this app already used for ACL Rules is
  independently confirmed live via Imperva's own legacy-API blog post
  (`action=RULE_ACTION_REDIRECT` against `my.incapsula.com/api/prov/v1`) — so
  Delivery Rules reuses it rather than adopting the newer transport.
- **`RULE_ACTION_WAF_OVERRIDE` is deliberately excluded** from Delivery Rules —
  it overrides a built-in WAF rule's action for a specific filter, a hybrid
  closer to Security Rules than to delivery/rewrite.
- **Data Centers' add/edit asymmetry is real, not a typo:**
  `sites/dataCenters/servers/add` takes `is_disabled` (inverted), while
  `sites/dataCenters/servers/edit` takes `is_enabled` (direct) — both honored
  exactly in `deploy.ts`/`rollback.ts`.
- **Security Rule Exceptions has no name to upsert by** — Imperva assigns only
  a numeric `whitelist_id` on create, and the same rule id can have many
  exceptions. This config type is the one place in this app that reconciles by
  a computed content signature (rule id + every match value, normalized)
  instead of a declared identity field.
- **Site Configuration's four write-only fields** (`domain_validation`,
  `approver`, `ignore_ssl`, `domain_redirect_to_full`) have no counterpart in
  the `/sites/status` read response — confirmed by comparing the full
  `SiteStatusResponse` struct in `client_site.go` against the fields
  `resource_site.go` sends. `driftDetect` simply never compares them and
  `rollback` reports them as NOT restorable rather than silently no-op.

### Intentionally excluded

- **Cache Rules, Delivery Rules Configuration, Performance/Application
  Delivery, Masking, Site SSL Settings, Site Monitoring, mTLS
  (client↔Imperva / Imperva↔origin), API Security, ATO, Bots Configuration,
  CSP/Client-Side Protection, Waiting Rooms, SIEM connections/log config,
  Policies, Domain Manager, Account SSL Settings, Certificate HSM/Short Renewal
  Cycle.** Every one of these lives on `BaseURLRev2`, `BaseURLRev3` or
  `BaseURLAPI` in the provider's own source — a genuinely different,
  non-legacy API surface this app deliberately stays off of (the same charter
  boundary drawn since 0.1.0). "Cache Rules" and "Delivery Rules Configuration"
  specifically are the modern v2/v3 replacements for what this app's Delivery
  Rules config type reaches on the legacy v1 IncapRules endpoint instead.
- **Custom Certificates** (`sites/customCertificate/upload` / `.../remove`) —
  genuinely v1, but the upload REQUIRES a `private_key` (PEM) parameter — that
  is credential material, not declarative config, the same boundary this app
  draws around every other secret. Not modeled.
- **Login Protect** — `/sites/status` echoes a read-only `login_protect` block
  (enabled, allowed users, URLs, auth methods), but no `client_login_protect.go`
  / write endpoint exists anywhere in Imperva's own official Terraform
  provider — the strongest signal available that this feature has no
  confirmed v1 write API (console/UI-only, or an older surface Imperva has
  not exposed to the provider). Not modeled; flagged rather than guessed at.
- **`remove_ssl`** (a `sites/configure` param) — reads as a one-shot "strip
  Imperva-managed SSL" action, not durable state; declaring it truthy on every
  deploy would be actively destructive. Not modeled (see Site Configuration
  above).
- **Sites lifecycle** (`sites/add`, `sites/delete`) and **subaccounts** — site
  onboarding/offboarding is a platform-provisioning action outside a
  configuration canvas's steady-state scope, the same boundary every other app
  in this catalog draws around resource creation vs. resource configuration.
- **Origin POP** (`sites/datacenter/origin-pop/modify`) — a narrow, add-on
  BGP-routing toggle per data center requiring a separate Imperva product
  license; not independently confirmed as broadly available, so left out of
  Data Centers rather than guessed at.
- **DDoS Protection beyond Security Rules' `api.threats.ddos`** — the
  `extended_ddos` field Imperva's `/sites/status` returns has no corresponding
  `sites/configure` param in the provider's own `updateParams` list, so no
  write path was found for it.
- **Account/Role/User management, API client self-management, data-storage
  region.** Control-plane/IAM administration and infrastructure placement, not
  per-site security posture — the same boundary this catalog draws elsewhere
  (e.g. Cortex XDR excludes `authentication-settings`/`api_keys`/`rbac`).

Primary references: Imperva's official open-source Terraform provider
(`github.com/imperva/terraform-provider-incapsula`), its `client_*.go` /
`resource_*.go` files and `website/docs/r/*.markdown` worked examples cited
above and in `CHANGELOG.md`, and `lib/impervaApi.ts` for the shared v1
transport. **Unverified against a live tenant** — see `CHANGELOG.md`'s
per-release FLAG notes; verify before relying on this in production.
