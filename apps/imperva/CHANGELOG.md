# Changelog

All notable changes to the Imperva app are documented here.

## 0.2.0 — 2026-08-01

Two declarative per-site edge-security config types, over the same legacy Cloud
WAF (Incapsula) **API v1** (`api_id` + `api_key` POST form params, `res === 0`
success envelope) as the 0.1.0 foundation.

- **Security Rules** config type — configure Imperva Cloud WAF threat protection
  per site over `POST /sites/configure/security` (`site_id`, `rule_id`, plus the
  parameters that rule takes). Covers the threat rules
  (`api.threats.sql_injection`, `cross_site_scripting`, `illegal_resource_access`,
  `remote_file_inclusion`, `backdoor`) driven by a `security_rule_action`; DDoS
  protection (`api.threats.ddos`: `activation_mode`, `ddos_traffic_threshold`,
  `unknown_clients_challenge`, `block_non_essential_bots`); and bot access control
  (`api.threats.bot_access_control`: `block_bad_bots`, `challenge_suspected_bots`).
  Each rule is a SINGLETON per site, so deploy is a declarative SET: it reads the
  prior value from `POST /sites/status` (`security.waf.rules[]`), applies the new
  value, and rollback re-applies the prior value. Validate is field-aware per rule
  kind; drift compares only the parameters an item declares. The canvas uses
  `visibleWhen` so the operator sees only the fields for the chosen rule.
- **ACL Configuration** config type — manage a site's ACL lists over `POST
  /sites/configure/acl` (`rule_id` one of `api.acl.blacklisted_ips`,
  `whitelisted_ips`, `blacklisted_countries`, `blacklisted_urls`). This endpoint is
  a per-site SET — the submitted value REPLACES the whole list for that ACL type —
  so the config type is declarative: the canvas holds the full desired list
  (`ips`, `countries` + `continents`, or `urls` + `url_patterns`). Deploy records
  the prior list from `POST /sites/status` (`security.acls.rules[]`) for rollback;
  drift compares lists order-insensitively (URLs as value|pattern pairs).
- **Shared v1 client additions** (`lib/impervaApi.ts`) — `SECURITY_CONFIGURE_PATH`,
  `ACL_CONFIGURE_PATH`, `SITE_STATUS_PATH`; `fetchSiteStatus()` (the read-side for
  both new types); and `isAclApiSuccess()` (the ACL configure endpoint reports
  success as `res === 0` **or** `res === 2`).

> **API provenance / FLAG.** Endpoints, `rule_id` / `acl_id` enums, per-rule
> parameters, the `security_rule_action` and DDoS value sets, the URL-pattern enum,
> and the `/sites/status` `security.waf.rules` / `security.acls.rules` read shapes
> were taken from Imperva's **official open-source Terraform provider**
> (`github.com/imperva/terraform-provider-incapsula`:
> `incapsula/client_waf_security_rule.go`, `resource_waf_security_rule.go`,
> `incapsula/client_acl_security_rule.go`, `incapsula/client_site.go`) and the
> `waf_security_rule` / `acl_security_rule` docs. **Unverified against a live
> tenant:** (1) the exact `/sites/status` response shape; (2) the meaning of the
> ACL endpoint's `res === 2` (treated as success, matching the provider); (3)
> whether submitting an **empty** `countries` / `continents` param clears a country
> blacklist — the provider omits empty geo params (so a clear is not expressible on
> deploy), while ACL **rollback** submits them empty to restore an empty prior set.
> **Verify against a live Imperva account.**

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **ACL Rules** config type — author Imperva Cloud WAF (formerly Incapsula) site
  security / ACL rules (`siteId`, `name`, `action`, `filter`, `enabled`) and sync
  them over the legacy Cloud WAF management **API v1**
  (`POST /sites/incapRules/{add,edit,delete,list}`), with validate / deploy
  (upsert by rule **name within a site**) / rollback (restore the prior rule, or
  delete a rule we created) / health-check / drift-detect / status. Supported
  security actions: `RULE_ACTION_BLOCK`, `RULE_ACTION_ALERT`,
  `RULE_ACTION_BLOCK_USER`, `RULE_ACTION_BLOCK_IP`, `RULE_ACTION_RETRY`,
  `RULE_ACTION_INTRUSIVE_HTML`, `RULE_ACTION_CAPTCHA`.
- **Cloud WAF v1 API client** — isolated in `lib/impervaApi.ts`. Auth is an
  `api_id` + `api_key` pair sent as POST form parameters on every call; the base
  URL is fixed by default (`https://my.imperva.com/api/prov/v1`) but a connection
  may override it. Every response is checked against the v1 `res === 0` success
  envelope (an HTTP 200 does not imply success). Credentials map from the Cloud
  Security Console: API ID → credential username, API key → credential API token.
- **Connectivity test** against the Cloud WAF API (`POST /account`), reading the
  `res` envelope so a wrong API ID / API key is reported distinctly from an
  unreachable endpoint.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key →
  connection → author) and Connections (wraps the SDK `ConnectionsManager`;
  saving a connection registers `imperva` as a deploy target).

> **API provenance / FLAG.** Auth (`api_id` + `api_key` POST params, base URL
> `https://my.imperva.com/api/prov/v1`), the IncapRule field shape (`name`,
> `action`, `filter`, `enabled`, `rule_id`), the full security **action** enum and
> the `filter` expression examples were taken from Imperva's **official
> open-source Terraform provider**
> (`github.com/imperva/terraform-provider-incapsula`:
> `incapsula/client_incap_rule.go`, `website/docs/r/incap_rule.html.markdown`,
> `incapsula/config.go`) and Imperva's Cloud Application Security Sites API docs.
> The exact v1 **list-response envelope** for `incapRules/list` (whether rules
> arrive under `incap_rules`, `rules`, or an `{ All: [...] }` bucket) and the
> precise non-zero `res` codes are tolerated defensively in code but were **not**
> confirmed against a live tenant — **verify against a live Imperva account**.
>
> The **newer** Imperva platform (`https://api.imperva.com`, `x-API-Id` /
> `x-API-Key` **headers**) is a separate surface; this app deliberately targets
> the legacy v1 management API because it is the confirmed writable surface for
> IncapRules. A newer resource, `incapsula_delivery_rules_configuration`, exists
> for delivery rules but is out of scope for this security/ACL foundation.
