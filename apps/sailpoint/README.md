# SailPoint (Identity Security Cloud)

Manage **SailPoint Identity Security Cloud** (ISC, formerly IdentityNow)
configuration as code through the ISC API, with validation, drift detection and
rollback handled by the Veltrix Security-as-Code pipeline.

## What it manages

| Configuration type | ISC surface | Notes |
|---|---|---|
| **Transforms** | `/transforms/v1` | Identity-attribute transformation logic — name, operation `type`, and type-specific `attributes` (JSON). |

Transforms are matched by their **name** (unique and immutable in ISC). Built-in
(internal) transforms are protected — the app never modifies them — and because a
transform's `type` is immutable, a same-name transform of a different type is
reported as an error rather than silently replaced. Deploys reconcile live
transforms against the declared configuration and only ever delete transforms
this app created.

## Authentication

ISC authenticates via **OAuth2 client credentials**. Store the credential as:

- **Username** → ISC **Client ID** (a Personal Access Token's Client ID, or an
  API-management OAuth client id)
- **Password** → ISC **Client Secret**

Generate a PAT from an **ORG_ADMIN** user (config endpoints require ORG_ADMIN)
with the `idn:transform:manage` / `idn:transform:read` scopes. Set the tenant
**org name** (e.g. `acme`) in the app's **Tenant** setting — the API is reached at
`https://{org}.api.identitynow.com`. For non-standard hosts, use the optional
**API URL** override setting.

The app exchanges these for a bearer token (`POST /oauth/token`,
`grant_type=client_credentials`) and caches it until just before expiry. List
endpoints paginate with `offset`/`limit` (max 250); rate limiting (429) is
honored via `Retry-After`.

## Configuration type: Transforms

Each canvas item is one transform:

- **Name** — unique, 1–50 chars, immutable identity.
- **Type** — the operation type, e.g. `lower`, `upper`, `concat`, `dateFormat`,
  `static`, `lookup`, `conditional`, `reference`, `substring`, `firstValid`,
  `accountAttribute`. Immutable after create.
- **Attributes (JSON)** — the type-specific attributes object, e.g.
  `{"inputFormat":"MMM dd yyyy","outputFormat":"yyyy/MM/dd"}` for `dateFormat`.
  Blank/`{}` is valid for simple types like `lower`/`upper`.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs sailpoint

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/sailpoint
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
