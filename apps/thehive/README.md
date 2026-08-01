# 🐝 TheHive

Manage [TheHive](https://strangebee.com/thehive/) — the open-source Security
Incident Response Platform (SIRP / SOAR) — as code on the Veltrix
Security-as-Code platform. Author incident-response configuration in the
Configuration Canvas and drive it through the pipeline (validate → deploy →
rollback → health-check → drift-detect → status).

## How it's managed

TheHive exposes a single, uniform **REST API**. This app applies configuration
over that API:

- **REST** — case templates via the TheHive API. Authentication is a TheHive
  **API key** carried as a **Bearer token** (`Authorization: Bearer <key>`),
  stored as the connection credential's API token. TheHive is commonly fronted by
  a **self-signed certificate** (or served directly on `:9000`), which the
  transport tolerates — an explicit `http://` endpoint is honored too.

## Configuration types

| Type | Surface (TheHive 5, primary) | Identity | Status |
|---|---|---|---|
| **Case Templates** | `/api/v1/caseTemplate` (create/update/delete), listed via `POST /api/v1/query` | `name` | ✅ v0.1.0 |
| **Custom Fields** | `/api/v1/customField` (create `POST`, update `PATCH`, delete `DELETE`, list `GET`) | `name` | ✅ v0.2.0 |
| **Observable Types** | `/api/v1/observable/type` (create `POST`, delete `DELETE`, list via query `listObservableType`) — **no update endpoint** | `name` | ✅ v0.2.0 |
| **Users** | `/api/v1/user` (create `POST`, update `PATCH`, delete `DELETE /{id}/force`, list via query `listUser`) | `login` | ✅ v0.2.0 |

Each type upserts by its **identity** field (create vs update) and detects drift
against it; deploy snapshots the prior body so rollback can restore it (or delete
what it created).

- **Case Templates** — fields: `name` (identity), `displayName`, `titlePrefix`,
  `severity` (1–4), `tlp` (0–3), `pap` (0–3), `tags`, `description`, and `tasks`
  (one task title per line → prefilled tasks on every case).
- **Custom Fields** — fields: `name` (identity), `displayName`, `group`,
  `description`, `type`, `mandatory`, `options`. `type` is one of
  `string · integer · float · boolean · date · url`. TheHive 5 has **no separate
  `enumeration` type** — an enumerated field is a base type carrying an `options`
  allow-list. Update uses `InputUpdateCustomField`, which omits `name` (a field
  cannot be renamed in place).
- **Observable Types** — fields: `name` (identity), `isAttachment`. TheHive 5
  has **no update endpoint** for observable types, so deploy is
  **create-if-missing**: an existing type is left untouched (an `isAttachment`
  mismatch is reported by drift, not corrected) and rollback deletes only the
  types the deploy created.
- **Users** — fields: `login` (identity, lower-cased by TheHive), `name`,
  `email`, `profile` (role — must already exist in TheHive), `organisation`
  (blank inherits the API key's org). **Passwords and API keys are not managed
  here** — provision them out of band (credential material must not live in
  canvas config). Multi-org membership
  (`PUT /api/v1/user/{id}/organisations`) is out of scope.

## API dossier

Auth: **Bearer API key** (`Authorization: Bearer <apiKey>`). Base URL is the
TheHive instance (443 behind a proxy, or `:9000` direct). Connectivity check:
**`GET /api/v1/user/current`**.

### TheHive 4 vs 5 — the version seam

The two major versions differ in their case-template surface. This is isolated to
**one place** — `lib/thehiveApi.ts` (`API_VERSION` + `THEHIVE_PATHS`) — so a v4
deployment is a one-line switch.

| Operation | **TheHive 5 (primary)** | TheHive 4 (alternate) |
|---|---|---|
| Create | `POST /api/v1/caseTemplate` | `POST /api/case/template` |
| Get | `GET /api/v1/caseTemplate/{id}` | `GET /api/case/template/{id}` |
| Update | `PATCH /api/v1/caseTemplate/{id}` | `PATCH /api/case/template/{id}` |
| Delete | `DELETE /api/v1/caseTemplate/{id}` | `DELETE /api/case/template/{id}` |
| List / find | `POST /api/v1/query` `{ query: [{ _name: "listCaseTemplate" }] }` | `POST /api/case/template/_search` |
| Current user | `GET /api/v1/user/current` | `GET /api/v1/user/current` |

**Primary is TheHive 5** (StrangeBee). The v5 `_id` and v4 `id` fields are both
read via each type's `*Id()` helper.

The v0.2.0 config types add matching keys to both sides of the seam
(`THEHIVE_PATHS.v5` / `.v4` in `lib/thehiveApi.ts`). The TheHive 4 collection
paths below are the **flagged** legacy alternate — **unverified against a live
TheHive 4**:

| Type | TheHive 5 (primary) | TheHive 4 (alternate, flagged) |
|---|---|---|
| Custom fields | `/api/v1/customField` | `/api/customField` |
| Observable types | `/api/v1/observable/type` | `/api/observable/type` |
| Users | `/api/v1/user` (delete `/{id}/force`) | `/api/user` |

List operations use the v5 query API (`POST /api/v1/query` with
`{ query: [{ _name }] }`) for observable types (`listObservableType`) and users
(`listUser`); custom fields list via a plain `GET /api/v1/customField`.

Sources: TheHive 5 docs — <https://docs.strangebee.com/thehive/api-docs/> and the
Case Templates guides under
<https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-templates/case-templates/>;
`thehive4py` client (v5 endpoints + `InputCaseTemplate` shape) —
<https://github.com/TheHive-Project/TheHive4py>.

> ⚠️ **Verify against a live TheHive (note v4 vs v5).** Endpoint paths and the
> exact `InputCaseTemplate` field shapes above are derived from the official docs
> and the maintained `thehive4py` client; confirm them against your instance's
> version before trusting deploys.

## BYOL infrastructure (planned)

Hosting a self-managed TheHive stack — BYOL infrastructure provisioning plus the
app-owned database/migrations — is **planned for a later wave** and is
intentionally not part of this foundation. Today the app configures an existing
TheHive instance you point it at over a Connection.

## Notes

TLS verification is off by default (self-signed) and configurable via the
`verify_tls` setting. The `thehive_port` setting hints at the API port (443
behind a proxy, or 9000 direct).

Apache-2.0.
