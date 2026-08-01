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

| Type | Surface (TheHive 5, primary) | Status |
|---|---|---|
| **Case Templates** | `/api/v1/caseTemplate` (create/update/delete), listed via `POST /api/v1/query` | ✅ v0.1.0 |

The template **name** is the stable identity used to upsert (create vs update)
and to detect drift; deploy snapshots the prior template body so rollback can
restore it (or delete a template it created).

Fields authored per template: `name` (identity), `displayName`, `titlePrefix`,
`severity` (1–4), `tlp` (0–3), `pap` (0–3), `tags`, `description`, and `tasks`
(one task title per line → prefilled tasks on every case).

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
read via `templateId()`.

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
