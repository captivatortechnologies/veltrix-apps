# Cloudflare

Manage [Cloudflare](https://www.cloudflare.com/) configuration as code through the Cloudflare API
(v4). Author configurations in the platform's Configuration Canvas and deploy them through the
Security-as-Code pipeline — validate, deploy, health check, drift detection and rollback are handled
per configuration type.

## Credentials

Create a **scoped API token** in the Cloudflare dashboard (**My Profile → API Tokens**) and store it
as a Veltrix credential:

| Veltrix credential field | Cloudflare value |
| --- | --- |
| API token | The scoped API token |

Prefer a scoped token over the Global API Key — it can be limited to specific zones, accounts,
permissions and IP ranges, and can be rotated. Grant it the permission groups for what this app
manages (e.g. Zone → DNS Edit, Zone WAF Edit, Zone → Single Redirect / Transform Rules Edit,
Zone → Bot Management Edit, Account → Turnstile Edit, Account → Access: Apps and Policies Edit,
Account → Access: Authentication Methods Edit, Account → Access: Certificates Edit, Account → Zero
Trust Edit, Account → Account Filter Lists Edit). Every request is sent as
`Authorization: Bearer <token>` with `Accept: application/json`.

Register a **`cloudflare-zone`** component whose hostname is the zone (apex) **domain** (e.g.
`example.com`). The app resolves the **zone id** — and its owning **account id** — automatically via
`GET /zones?name=…`. For account-scoped types (Access, Gateway, Lists) with no zone registered, set
the **Account ID** app setting.

## What it manages

### Zone configuration
DNS records, and the WAF/firewall **Rulesets** engine: WAF custom rules, rate-limiting rules, single
redirects, transform rules (URL rewrite + request/response header transforms), managed-ruleset
deployment & overrides, **Bot Management**, plus zone settings.

### Account & Zero Trust configuration
Account Lists (IP / hostname / ASN), **Turnstile** widgets, Zero Trust **Access** (applications,
reusable policies, groups, service tokens, identity providers, mTLS root certificates), Zero Trust
**device posture rules**, and Zero Trust **Gateway** (rules and lists).

## Coverage

What this app manages as declarative, round-trippable configuration-as-code, versus what was
researched and deliberately left out — see `CHANGELOG.md` 1.5.0 for the full citations.

### Managed

| Group | Configuration type | Cloudflare API |
| --- | --- | --- |
| Zone | DNS Records | `/zones/{zone_id}/dns_records` |
| Zone | Zone Settings | `/zones/{zone_id}/settings/{id}` |
| WAF & Security | WAF Custom Rules | `/zones/{zone_id}/rulesets` (phase `http_request_firewall_custom`) |
| WAF & Security | Rate Limiting Rules | `/zones/{zone_id}/rulesets` (phase `http_ratelimit`) |
| WAF & Security | Managed Rulesets | `/zones/{zone_id}/rulesets` (phase `http_request_firewall_managed`) |
| WAF & Security | Bot Management | `/zones/{zone_id}/bot_management` |
| WAF & Security | Turnstile Widgets | `/accounts/{account_id}/challenges/widgets` |
| Rules & Lists | Redirect Rules | `/zones/{zone_id}/rulesets` (phase `http_request_dynamic_redirect`) |
| Rules & Lists | Transform Rules | `/zones/{zone_id}/rulesets` (rewrite/header phases) |
| Rules & Lists | Page Rules (Legacy) | `/zones/{zone_id}/pagerules` |
| Rules & Lists | Lists | `/accounts/{account_id}/rules/lists` |
| Zero Trust · Access | Applications | `/accounts/{account_id}/access/apps` |
| Zero Trust · Access | Policies | `/accounts/{account_id}/access/policies` |
| Zero Trust · Access | Groups | `/accounts/{account_id}/access/groups` |
| Zero Trust · Access | Service Tokens | `/accounts/{account_id}/access/service_tokens` |
| Zero Trust · Access | Identity Providers | `/accounts/{account_id}/access/identity_providers` |
| Zero Trust · Access | mTLS Certificates | `/accounts/{account_id}/access/certificates` |
| Zero Trust · Access | Device Posture Rules | `/accounts/{account_id}/devices/posture` |
| Zero Trust · Gateway | Policies | `/accounts/{account_id}/gateway/rules` |
| Zero Trust · Gateway | Lists | `/accounts/{account_id}/gateway/lists` |

### Excluded (researched, deliberately not added)

| Surface | Why |
| --- | --- |
| IP Access Rules (`/zones\|accounts/.../firewall/access_rules/rules`) | Still live on every plan, but Cloudflare's own docs recommend Custom Rules instead for IP/geography blocking — already covered here by **WAF Custom Rules** + **Lists** (`ip` kind) on the Rulesets engine Cloudflare is steering customers toward. |
| DLP Profiles (`/accounts/{account_id}/dlp/profiles`) | Genuine Enterprise-add-on surface, but its `entries` sub-schema is a deep discriminated union (pattern-match / predefined / exact-data / word-list / document-fingerprint) that even Cloudflare's own Terraform provider schema flags as unsupported (`x-stainless-skip: ["terraform"]`). Left for a dedicated future pass. |
| mTLS Certificates (general) (`/accounts/{account_id}/mtls_certificates`), origin TLS client auth, zone client certificates | Can require uploading a private key (an mTLS *identity*, not just a validating CA) and are origin/CDN connectivity certificate management rather than WAF/Zero Trust policy — outside this pass's security-policy scope. |
| Custom Pages (block/challenge page branding) | Cosmetic (which hosted HTML a challenge shows), not a security control in itself. |
| Notification/alerting policies (`/accounts/{account_id}/alerting/v3/...`) | An operational-notification surface (who gets paged), not a declarative security control — a better fit for a future observability-focused pass. |
| Cloudflare Tunnel (`/accounts/{account_id}/cfd_tunnel`) | Network connectivity/access infrastructure (exposing private origins) rather than a security policy surface; the `token` endpoint also returns run-time secret material. |

## Cloudflare-specific behaviour the app handles

- **The Rulesets engine.** Modern WAF/firewall/rate-limiting/transform/redirect config is an ordered
  list of rules inside a **phase entrypoint ruleset**. The app reconciles each phase declaratively and
  keys rules on their stable, user-settable **`ref`** (not the server `id`, which changes when a
  ruleset is modified).
- **Managed rulesets are override-only.** Cloudflare-managed WAF rulesets are read-only; the app
  deploys them via an `execute` rule and applies ruleset/category/rule-level overrides — never editing
  the managed rules themselves.
- **Zone vs account scope.** The component domain resolves to a `zone_id` (and its `account_id`) once,
  cached for the process. Account-scoped objects use the derived account or the `account_id` setting.
- **Write-only secrets.** Access **service-token** client secrets and **Turnstile widget** secrets are
  shown once at creation (Cloudflare redacts them on every later read) — the app supplies them on
  write and never reads them back or diffs them in drift. An **identity provider**'s `client_secret`
  (and equivalent fields) is likewise write-only, so drift on that type reports presence + type only,
  never a value diff of its config.
- **Identity that survives environments.** Rulesets rules key on `ref`; DNS on `(type, name, content)`;
  account objects on their `name`. The app persists/derives these so re-runs update rather than
  duplicate.
- **Immutable-after-creation fields.** An Access mTLS certificate's PEM content and a Turnstile
  widget's region can only be set at creation — Cloudflare's API has no way to change either
  afterward (and never echoes the certificate content back at all). The app documents this rather
  than working around it: rotating either means adding a new item.
- **Bot Management is read-merge-write, not a sparse patch.** Cloudflare's `PUT
  /bot_management` is a full snapshot of the fields you send, and which fields your plan accepts is
  itself plan-gated. The app reads the current live object, merges the declared fields on top, and
  PUTs the merged result — so an unmanaged or plan-inapplicable field is never silently reset.
- Envelope + errors: responses use `{ success, errors[], result, result_info }`; the app treats a
  response as OK only when the HTTP status is 2xx **and** `success` is not `false`, and surfaces the
  `errors[]` codes/messages on failure. Honors `429 Retry-After`.

## Health check

Handlers make a cheap authenticated read (the zone lookup / a paged list) to prove the token works
before doing any work, then confirm each declared object is present.

## References

- Cloudflare API: <https://developers.cloudflare.com/api/>
- Rulesets engine: <https://developers.cloudflare.com/ruleset-engine/>
- Zero Trust: <https://developers.cloudflare.com/cloudflare-one/>
