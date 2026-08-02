# Illumio

Manage **Illumio Core** (Policy Compute Engine) microsegmentation configuration
as code through the Illumio REST API v2, with validation, drift detection and
rollback handled by the Veltrix Security-as-Code pipeline.

## What it manages

| Configuration type | PCE surface | Notes |
|---|---|---|
| **Labels** | `/orgs/{org_id}/labels` | Key/value policy objects (role, app, env, loc, or a custom dimension) used to scope rulesets, enforcement boundaries and the illumination map. |

A label's identity is its **(key, value) pair** — not either field alone, since
the same value can recur under different keys (e.g. `env=Prod` and
`loc=Prod` are different labels). Deploy lists the org's labels, creates any
that are missing, and syncs `external_data_set` / `external_data_reference`
metadata on ones that already exist (`key` is immutable in the PCE once
created). Reconcile only deletes labels this app created but no longer
declares — a label that already existed before this app touched it is never
removed.

> **Out of scope for this release:** security policy (rule sets, rules,
> services, IP lists, enforcement boundaries) lives under the PCE's
> **draft-then-provision** model — edits go to
> `/orgs/{org_id}/sec_policy/draft/<resource>`, then a
> `POST /orgs/{org_id}/sec_policy` "provisions" (commits) the changed hrefs
> into a new active policy version. That two-phase commit needs its own
> pipeline shape and is planned for a follow-up release once verified against
> a live PCE. Custom label dimensions (`/orgs/{org_id}/label_dimensions`, PCE
> 22.5+) are similarly out of scope — `key` must already exist as one of the
> PCE's four built-in dimensions (`role`, `app`, `env`, `loc`) or a custom
> dimension created directly in the PCE.

## Authentication

Illumio authenticates with a **PCE API key** over HTTP Basic auth — the same
scheme the Illumio Python SDK (`pce.set_credentials(key, secret)`) and
Terraform provider use. Store the credential as:

- **API key username** → the API key (e.g. `api_145a5c788e2ba897c`)
- **API key secret** → the key's secret

Set the PCE **host**, **port** (default `8443`), **organization ID** (default
`1`) and **Verify TLS certificate** (off by default — on-premises PCEs
commonly ship a self-signed or internal-CA certificate) in the app's settings;
a Veltrix installation manages one PCE, so these are app-level settings rather
than per-connection fields.

## Configuration type: Labels

Each canvas item is one label:

- **Key** — the label dimension (`role`, `app`, `env`, `loc`, or an existing
  custom dimension), ≤ 64 characters.
- **Value** — the label's value within that key, e.g. `R-DB` for `role`.
- **External data set / reference** — optional integration metadata
  (`external_data_set` / `external_data_reference`), carried through
  unchanged on every deploy.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs illumio

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/illumio
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.

## References

- Illumio Core REST API guide (labels & label groups):
  https://docs.illumio.com/core/23.2/Content/Guides/security-policy/security-policy-objects/labels-and-label-groups.htm
- `illumio-py` (official Python SDK) — base URL, org scoping, Basic auth, TLS
  verification, connectivity check:
  https://github.com/illumio/illumio-py
- `terraform-provider-illumio-core` — label resource/data-source schema
  (key/value, external_data_set/reference, `key` immutability):
  https://github.com/illumio/terraform-provider-illumio-core
