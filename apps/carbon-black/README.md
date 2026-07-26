# VMware Carbon Black

Manage **VMware Carbon Black Cloud** configuration as code through the CBC API,
with validation, drift detection and rollback handled by the Veltrix
Security-as-Code pipeline.

## What it manages

| Configuration type | Carbon Black surface | Notes |
|---|---|---|
| **Reputation Overrides** | `/appservices/v6/orgs/{org_key}/reputations/overrides` | Allow/ban entries by SHA256 hash, signing certificate, or IT-tool path. |

Carbon Black reputation overrides have **no update API**, so the app matches a
declared override to a live one by its **natural key** — the override type plus
its identifying value (a SHA256 hash, a signing certificate, or an IT-tool path)
— and applies any change as **delete + recreate**. The original pre-management
state is carried forward across deploys so rollback can restore it. Reconcile
only deletes overrides this app created but no longer declares.

## Authentication

Carbon Black authenticates with an **API key** sent as
`X-Auth-Token: <API Secret Key>/<API ID>` (secret first). In **Settings > API
Access**, create a **Custom** access level granting `org.reputations`
CREATE/READ/DELETE, then an API key with it. Store the credential as:

- **Username** → the API ID
- **Password** → the API Secret Key

Set the region **Base URL** (e.g. `https://defense.conferdeploy.net`; EU/APAC
differ) and your **Org Key** in the app's settings.

## Configuration type: Reputation Overrides

Each canvas item is one override:

- **Label** — a friendly canvas identity (not sent to Carbon Black).
- **List** — `BLACK_LIST` (ban) or `WHITE_LIST` (allow).
- **Type** — `SHA256`, `CERT`, or `IT_TOOL`, with the matching identifier
  (SHA256 hash / signed-by + certificate authority / path).
- **Description** — optional.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs carbon-black

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/carbon-black
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
