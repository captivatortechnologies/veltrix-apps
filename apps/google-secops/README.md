# Google SecOps

Manage **Google Security Operations** (Chronicle) configuration as code through
the SecOps REST API, with validation, drift detection and rollback handled by the
Veltrix Security-as-Code pipeline.

## What it manages

| Configuration type | Google SecOps surface | Notes |
|---|---|---|
| **Reference Lists** | `.../referenceLists` | Named sets of string, regex, or CIDR entries. |

Reference lists are keyed by their immutable **reference list id**. Deploy reads
the live list and PATCHes its entries + description to exactly the declared values
(entries are a full replace), or creates the list if absent. The **syntax type is
fixed at creation**. Reference lists **cannot be deleted**, so reconcile empties
the ones this app created but no longer declares, and rollback restores prior
entries (or empties a created list).

## Authentication

Google SecOps authenticates with a **Google service account**. Create a service
account with the Chronicle API access for reference lists, download its **JSON
key**, and store the credential as:

- **Password** → the entire service-account JSON key (paste the whole file)

The app builds and signs (RS256) a JWT with the key's private key (via Node's
built-in crypto) and exchanges it for a short-lived Bearer token, refreshing it
automatically. Set the **Region** (e.g. `us`, `europe-west2`), **Project ID** and
**Instance ID** in the app's settings.

## Configuration type: Reference Lists

Each canvas item is one reference list:

- **Name (reference list ID)** — starts with a letter; letters/digits/underscores
  only; immutable.
- **Syntax Type** — `plain`, `regex`, or `cidr` (fixed at creation).
- **Description** — optional.
- **Entries** — one per line (≤ 512 chars each), reconciled to exactly this list.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs google-secops

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/google-secops
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
