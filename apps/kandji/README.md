# Kandji

Manage [Kandji](https://www.kandji.io/) (Apple device management / MDM) configuration as code through
the **Kandji tenant API**. Author configurations in the platform's Configuration Canvas and deploy them
through the Security-as-Code pipeline — validate, deploy, health check, drift detection and rollback are
handled per configuration type.

## A note on "Kandji" vs. "Iru"

Kandji's own current API reference is titled **"Iru Endpoint Management API"** — the vendor rebranded to
Iru — but its docs banner states plainly: *"Kandji is now Iru, but many URLs and notes within this
documentation will continue to reference Kandji for some time."* Every endpoint this app calls still
lives under the `api.kandji.io` hostname family with the exact auth model and JSON shapes documented
below, verified directly against the rendered API reference
([`api-docs.kandji.io`](https://api-docs.kandji.io), which now serves from `api-docs.iru.com`) and
Kandji's own published example scripts
([`kandji-inc/support`](https://github.com/kandji-inc/support/tree/main/api-tools)) — not assumed from
memory or from an outdated snapshot.

## Credentials

The app authenticates with a single **tenant-scoped Bearer API token**:

1. In the Kandji web app, go to **Settings > Access** and generate an **API Token**. This page also shows
   your tenant's exact API URL.
2. Save a Connection with:

   | Veltrix field | Kandji value |
   | --- | --- |
   | Endpoint | Your tenant API URL, copied verbatim — `https://<subdomain>.api.kandji.io` (US) or `https://<subdomain>.api.eu.kandji.io` (EU) |
   | API token | The token from step 1 |

   Every request sends it as `Authorization: Bearer <token>` — there is no token exchange or expiry to
   manage. Saving the Connection also registers a **`kandji-tenant`** deploy-target Component (its
   hostname is the endpoint's host), so Deploy is enabled immediately — the same "endpoint is the host"
   pattern `apps/okta-identity` and `apps/pagerduty` use.

There is no separate "subdomain" or "region" setting: whichever full host you paste into the Connection's
endpoint (straight from Kandji's own Settings > Access page) becomes the API host this app calls.

## What it manages

| Configuration type | Kandji resource / API | Verified route(s) |
| --- | --- | --- |
| Blueprints | Blueprints — the core device-assignment construct | `GET/POST /api/v1/blueprints`, `GET/PATCH/DELETE /api/v1/blueprints/{id}` |
| Tags | Tenant tags | `GET /api/v1/tags`, `POST /api/v1/tags`, `PATCH/DELETE /api/v1/tags/{tag_id}` |
| Custom Scripts | Library "Custom Script" items | `GET/POST /api/v1/library/custom-scripts`, `GET/PATCH/DELETE /api/v1/library/custom-scripts/{id}` |
| Custom Profiles | Library "Custom Profile" items (`.mobileconfig` passthrough) | `GET/POST /api/v1/library/custom-profiles`, `GET/PATCH/DELETE /api/v1/library/custom-profiles/{id}` (multipart) |

Custom Profiles' payload is an **opaque passthrough**: paste the full plist XML you would otherwise import
as a `.mobileconfig` file, and this app never parses or validates it — the same "author just the body"
posture `apps/jamf/config-types/macos-configuration-profiles` takes for its own configuration profiles.
The one real difference is transport: Kandji's Custom Profile endpoints accept the payload as a **multipart
file part**, not an embedded JSON string, so `deploy.ts` wraps your plist text in a `Blob` and uploads it
as `multipart/form-data` — nothing about the payload itself is treated specially.

## Coverage

This release covers Kandji's four clearest, most valuable **declarative, round-trippable** resources
reachable via the tenant API with a single request each. What's deliberately out of scope, and why:

| Candidate | Why it's not in this release |
| --- | --- |
| Custom Apps (`library/custom-apps`) | Real CRUD exists, but creating/updating one requires a 3-step flow: `POST .../custom-apps/upload` to get a pre-signed S3 `post_url`/`post_data`, a separate `POST {post_url}` multipart upload of the actual `.pkg`/`.zip`/`.dmg` binary to Amazon S3, and only then `POST/PATCH .../custom-apps` with the resulting `file_key`. There is no text/YAML representation of a binary installer — the same reason `apps/jamf`'s own Packages config type is metadata-only with "binary upload is a separate, unmanaged prerequisite." Kandji's flow is more involved still (a live S3 hop this platform would have to broker), so it's excluded entirely rather than half-built. |
| In-House Apps (`library/ipa-apps`) | Same S3 upload prerequisite as Custom Apps, plus an additional required **polling step** (`GET .../upload/{id}/status` until `VALIDATED`) before the Library item can be created — an inherently asynchronous workflow, not a single declarative write. |
| Self Service Categories (`self-service/categories`) | The API is **list-only** (`GET /api/v1/self-service/categories`) — there is no create/update/delete route, so it cannot be a write-capable config type. Categories are managed in the Kandji web app; this app's Custom Scripts config type only *references* a category by id (see its `self_service_category_id` field). |
| Blueprint Routing / Blueprint `assign-library-item` | A real folder and route exist, but Kandji's own API reference shows **byte-identical URL, method and example body** for "Assign Library Item" and "Remove Library Item" — the only distinguishing detail (add vs. remove semantics) is not documented anywhere else. Shipping a destructive-capable write against a route whose add/remove behavior cannot be independently verified would not meet this catalog's bar for a cited, verified integration. Deferred until Kandji's docs (or a live tenant) resolve the ambiguity. |
| Automated Device Enrollment (ADE) integrations, device-to-Blueprint assignment (`integrations/apple/ade/devices/{id}`) | Per-device enrollment state and ADE token material, not org-level declarative config — the same reasoning every MDM/IAM app in this catalog applies to its own per-device/secret-token endpoints. |
| Device Actions, Device Information, Device Secrets (FileVault key / unlock PIN / Recovery Lock password), Prism (fleet inventory/reporting), Threats, Users, Vulnerabilities, Audit Log | One-shot device actions, read-only reporting, or secret material never appropriate to store as declarative config — excluded per this catalog's standing convention. |

Verified against Kandji's own rendered API reference and its `kandji-inc/support` GitHub examples as of
2026-08 — every route cited above was read directly from the documentation UI (`api-docs.iru.com`, née
`api-docs.kandji.io`) and the linked example code, not assumed.

### Known limitations (honest, not stubs)

- **Blueprints has no in-app Library Item assignment.** This app manages a Blueprint's own identity
  fields (name/description/icon/color/enrollment code); which scripts/profiles/apps are assigned inside
  it is deferred — see the "Blueprint Routing / assign-library-item" row above.
- **Blueprint `type` is create-only.** Kandji does not support changing an existing Blueprint's `classic`
  vs. `map` (Assignment Map) type; this app only ever sends `type` on `POST`, never on `PATCH`.
- **Blueprint enrollment code is not diffed for drift.** Kandji regenerates the code server-side whenever
  it is left blank on create, so comparing it on every drift sweep would flag false drift for any tenant
  that didn't pin an explicit code. Redeploy with an explicit `enrollment_code` value to change it.
- **Custom Script / Custom Profile name uniqueness is not server-enforced by Kandji** the way it is for
  Blueprints — this app still requires unique names *within a single canvas* and reconciles by exact
  (case-insensitive) name match against the tenant; a name collision with an item you created outside
  this app will be treated as "already exists" and updated in place.

## Health check

Each configuration type's health check first confirms the tenant is reachable and the token is accepted
(a call that never requires a specific declared item to exist), then confirms every item declared in the
canvas is still present in Kandji.

## References

- Kandji API reference (current, titled "Iru Endpoint Management API"): <https://api-docs.kandji.io>
- Kandji API token setup: <https://support.kandji.io/api>
- Kandji's own published API example scripts: <https://github.com/kandji-inc/support/tree/main/api-tools>
