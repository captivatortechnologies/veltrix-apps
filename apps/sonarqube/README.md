# SonarQube (Veltrix app)

Manage **SonarQube quality gates as code**. Author a quality gate — its name,
default flag, and pass/fail conditions — in the Veltrix Configuration Canvas and
drive it through the Security-as-Code pipeline: **validate → deploy → health check →
drift detection → rollback**. Everything is applied over the **SonarQube Web API**.

Category: **COMPLIANCE**. App id: `sonarqube`.

## What it manages

| Configuration type | What it does | API |
| --- | --- | --- |
| **Quality Gates** | Create/edit quality gates and reconcile their conditions; optionally set the org default | `/api/qualitygates/*` |

A quality gate is authored as:

- **Name** — the gate's identity (used for upsert and drift).
- **Set as default** — make this the organization's default gate.
- **Conditions** — one per line, `<metric> <LT|GT> <threshold>`. Examples:

  ```
  new_coverage LT 80
  new_duplicated_lines_density GT 3
  new_reliability_rating GT 1
  ```

  `LT` fails when the value is lower than the threshold; `GT` fails when greater.
  SonarQube allows **one condition per metric per gate**, so conditions are
  reconciled by metric (create new, update changed, delete removed). Lines starting
  with `#` are ignored.

## Connecting

1. **API token** — in SonarQube, **My Account → Security**, generate a token whose
   user has **Administer Quality Gates**. Store it as a Veltrix credential (API
   token field).
2. **Connection** — on the **Connections** page, add a connection pointing at your
   SonarQube URL (`https://sonarqube.example.com`, or `http://host:9000`) and attach
   the token. **Test** verifies reachability + auth.
3. **Author & deploy** — open the Configuration Canvas, pick **Quality Gates**, add
   your gates, and deploy.

### Authentication

SonarQube authenticates with a **token**. The app sends it as **HTTP Basic with the
token as the username and an empty password** (`Authorization: Basic base64("<token>:")`),
which works on every SonarQube version. Newer servers (9.x+) additionally accept the
**bearer** scheme (`Authorization: Bearer <token>`). No username is required.

- **Base URL:** `<host>/api` (e.g. `https://sonarqube.example.com/api/qualitygates/list`).
- **Connectivity:** `GET /api/system/status` (unauthenticated; returns `{ id, version, status }`)
  and `GET /api/authentication/validate` (returns `{ valid: true }`).
- **TLS:** self-signed certificates are tolerated (self-hosted SonarQube is commonly
  behind one). The `verify_tls` setting is present for future enforcement.

> API paths/parameters follow the documented SonarQube Web API and should be verified
> against your SonarQube version. Older servers used `gateId` where current servers use
> `gateName` on condition endpoints; this app uses `gateName`.

## Layout

```
apps/sonarqube/
  manifest.yaml
  lib/sonarqubeApi.ts               # token Basic-auth REST seam (http/https, self-signed tolerated, form-encoded writes)
  config-types/quality-gates/       # canvas + defaults + validate/deploy/rollback/healthCheck/driftDetect/getStatus + tests
  server/index.ts                   # /meta + /settings
  handlers/testConnection.ts        # connectivity test
  hooks/                            # onInstall / onUninstall
  client/                           # Overview / Setup Guide / Connections pages
```

## Roadmap

- **BYOL infrastructure hosting** — provision and manage a SonarQube server
  (SonarQube + PostgreSQL) from Veltrix, mirroring the MISP app's BYOL console. Not
  included in `0.1.0`.
- Additional configuration types (permission templates, project settings, webhooks).
