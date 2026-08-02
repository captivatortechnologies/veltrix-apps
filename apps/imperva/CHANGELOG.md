# Changelog

All notable changes to the Imperva app are documented here.

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
