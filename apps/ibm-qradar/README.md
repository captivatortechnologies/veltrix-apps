# IBM QRadar

Manage **IBM QRadar** configuration as code through the QRadar REST API, with
validation, drift detection and rollback handled by the Veltrix Security-as-Code
pipeline.

## What it manages

| Configuration type | QRadar surface | Notes |
|---|---|---|
| **Reference Sets** | `/reference_data/sets` | Named, typed value collections. |

Reference sets are matched by **name** (the classic reference-data API is
name-keyed). Deploy reads the live set, reconciles its **values** to exactly the
declared list (adds missing, removes extra), and creates the set if absent. The
**element type is immutable**, so a same-name set of a different type is not
modified. Reconcile only deletes sets this app created but no longer declares.

## Authentication

QRadar authenticates with an **authorized-service token**. In **Admin >
Authorized Services**, create a service with a role that has reference-data
(admin) permission and copy its token. Store the credential as:

- **Password** → the authorized-service token

The app sends it in the `SEC` header on every request, plus a `Version` header
pinning the API version. Set the **Console Host** (e.g. `qradar.example.com`) and
**API Version** (default `20.0`) in the app's settings.

> **TLS note:** this app uses the standard TLS stack, so the QRadar console must
> present a certificate the host trusts (a valid CA chain).

## Configuration type: Reference Sets

Each canvas item is one reference set:

- **Name** — the set identity (unique in the canvas).
- **Element Type** — `ALN`, `ALNIC`, `IP`, `NUM`, `PORT`, or `DATE` (immutable
  after create).
- **Values** — one value per line, reconciled to exactly this list.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs ibm-qradar

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/ibm-qradar
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
