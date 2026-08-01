# Cisco Umbrella

Manage **Cisco Umbrella** (Secure Internet Gateway / DNS-layer security) policy
configuration as code through the Umbrella API, with validation, drift detection
and rollback handled by the Veltrix Security-as-Code pipeline.

## What it manages

| Configuration type | Umbrella API surface | Notes |
|---|---|---|
| **Destination Lists** | `/policies/v2/destinationlists` | Allow / block lists of domains, URLs and IPs. |

Umbrella destination lists are addressed by an opaque numeric **id** (there is no
lookup-by-name), so the app matches a declared list to a live one by **name** and
stores the id from the deploy for rename-safety on the next deploy. A list's
`access` (allow/block) and global scope are set at create time and are
**immutable** afterward; the list's destinations are synced to exactly what is
declared. Reconcile only deletes lists this app created but no longer declares.

## Authentication

The Umbrella API uses the **OAuth2 client-credentials** flow. Create an API key
in the Umbrella dashboard under **Admin → API Keys** with the **Destination
Lists** scope (read/write), and store the credential as:

- **Username** → the **API Key**
- **API token** → the **API Secret**

On every run the app exchanges the key + secret for a short-lived bearer token
(`POST https://api.umbrella.com/auth/v2/token`, HTTP Basic + `grant_type=client_credentials`,
~1 hour lifetime) and calls the API with `Authorization: Bearer <token>`. The base
URL is fixed to `https://api.umbrella.com` (no per-tenant host).

## Configuration type: Destination Lists

Each canvas item is one destination list:

- **Name** — the logical identity (unique in the canvas), ≤ 50 chars.
- **Access** — `block` or `allow` (immutable after create).
- **Global list** — whether it applies to all policies (immutable after create).
- **Destinations** — one per line: a domain (`example.com`), a URL
  (`example.com/path`, block lists only) or an IPv4 / CIDR (`10.0.0.0/24`, allow
  lists only). Up to 500 per list; synced to exactly these values on deploy.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs cisco-umbrella

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/cisco-umbrella
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
