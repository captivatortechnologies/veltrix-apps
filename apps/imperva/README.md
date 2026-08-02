# Imperva

Manage **Imperva Cloud WAF** (formerly **Incapsula**) edge security as code.
Author **site security / ACL rules** — block, alert or challenge traffic by client
IP, geography or URL — and drive them through the Veltrix Security-as-Code
pipeline: **validate → deploy → health check → drift detect → rollback**.

- **Category:** NETWORK
- **Config types:** ACL Rules (`acl-rules`)
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

## Provenance / verify against a live Imperva

Auth, the IncapRule field shape, the security **action** enum and the `filter`
examples are taken from Imperva's **official open-source Terraform provider**
(`github.com/imperva/terraform-provider-incapsula`) and the Cloud Application
Security Sites API docs. The exact **list-response envelope** for
`incapRules/list` and the precise non-zero `res` codes are handled defensively in
code but were not confirmed end-to-end — **verify against a live Imperva
account**. See `CHANGELOG.md` for the flagged items.
