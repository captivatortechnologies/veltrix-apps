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
Account → Access: Apps and Policies Edit, Account → Zero Trust Edit, Account → Account Filter Lists
Edit). Every request is sent as `Authorization: Bearer <token>` with `Accept: application/json`.

Register a **`cloudflare-zone`** component whose hostname is the zone (apex) **domain** (e.g.
`example.com`). The app resolves the **zone id** — and its owning **account id** — automatically via
`GET /zones?name=…`. For account-scoped types (Access, Gateway, Lists) with no zone registered, set
the **Account ID** app setting.

## What it manages

### Zone configuration
DNS records, and the WAF/firewall **Rulesets** engine: WAF custom rules, rate-limiting rules, single
redirects, transform rules (URL rewrite + request/response header transforms), managed-ruleset
deployment & overrides, plus zone settings.

### Account & Zero Trust configuration
Account Lists (IP / hostname / ASN), Zero Trust **Access** (applications, reusable policies, groups,
service tokens), and Zero Trust **Gateway** (rules and lists).

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
- **Write-only secrets.** Access **service-token** client secrets are shown once at creation — the app
  supplies them on write and never reads them back or diffs them in drift.
- **Identity that survives environments.** Rulesets rules key on `ref`; DNS on `(type, name, content)`;
  account objects on their `name`. The app persists/derives these so re-runs update rather than
  duplicate.
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
