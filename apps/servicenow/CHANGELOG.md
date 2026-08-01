# Changelog — ServiceNow

All notable changes to the ServiceNow Veltrix app are documented here.

## 0.1.0 — 2026-08-01

Initial foundation.

- **Business Rules** configuration type (`sys_script`): manage ServiceNow
  business rules as code — name, table (`collection`), timing (`when`:
  before/after/async/display), execution order, active/advanced flags, database
  triggers (insert/update/delete/query), an encoded filter condition and the
  server-side script — through the full Security-as-Code pipeline (validate,
  deploy, health check, drift detection, rollback).
- **Table API client** (`lib/servicenowApi.ts`): HTTP Basic-auth client for the
  ServiceNow Table API (`/api/now/table/{table}`) with list / get / create
  (POST) / update (PATCH) / delete, the `result` envelope helpers, and a request
  timeout setting.
- **Upsert by natural key**: rules are matched by their `(name, collection)`
  identity — query-then-POST/PATCH — so re-deploying is idempotent. Rollback
  deletes rules this app created and restores prior field values for rules it
  updated.
- **Connections**: instance address + integration-user username/password, with a
  per-row connectivity test (`GET /api/now/table/sys_user?sysparm_limit=1`).
- **Overview** and **Setup Guide** pages.

### Scope & caveats

- ServiceNow is a very large platform. v0.1.0 deliberately manages a single,
  security-relevant, cleanly-writable surface (business rules). More
  configuration types will follow.
- Authentication is HTTP Basic only in this release. OAuth 2.0
  (`/oauth_token.do` → Bearer) is ServiceNow's recommended production method and
  is a planned follow-up.
- Writing business rules writes executable server-side code to the instance and
  typically requires the `admin` role — treat the integration credential
  accordingly.
