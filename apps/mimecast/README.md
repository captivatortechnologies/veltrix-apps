# Mimecast

Manage **Mimecast** configuration as code through the Mimecast API 2.0, with
validation, drift detection and rollback handled by the Veltrix Security-as-Code
pipeline.

## What it manages

| Configuration type | Mimecast surface | Notes |
|---|---|---|
| **Managed URLs** | `/api/ttp/url/...` | Targeted Threat Protection permit/block URLs. |

Managed URLs are created by value (URL + match type + action) but have **no update
API**, so the app matches a declared entry to a live one by its **URL identity**
(match type + normalized url/domain) and applies any change as **delete +
recreate**. The original pre-management entry is carried forward across deploys so
rollback can restore it. Reconcile only deletes entries this app created but no
longer declares.

## Authentication

Mimecast authenticates with an **API 2.0 application** using OAuth2 client
credentials. In the Mimecast Admin Console, register an API 2.0 application with a
role granting **Services | URL Protection | Edit**, and store the credential as:

- **Username** → the Client ID
- **Password** → the Client Secret

The app exchanges these for a short-lived Bearer token (`POST /oauth/token`),
refreshing it automatically. The default base URL is
`https://api.services.mimecast.com`; override it in the app's settings only if
your tenant uses a different gateway host.

## Configuration type: Managed URLs

Each canvas item is one managed URL:

- **URL** — the URL or domain (no fragment `#`).
- **Action** — `block` or `permit`.
- **Match Type** — `explicit` (the whole URL) or `domain`.
- **Comment** — optional.
- **Permit options** — `disableRewrite` / `disableUserAwareness` (permit only),
  `disableLogClick`.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs mimecast

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/mimecast
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
