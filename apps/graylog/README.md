# 📊 Graylog

Manage [Graylog](https://www.graylog.org) — the open-source SIEM / log-management
platform — as code on the Veltrix Security-as-Code platform. Author stream
configuration in the Configuration Canvas and drive it through the pipeline
(validate → deploy → rollback → health-check → drift-detect → status).

## How it's managed

Graylog exposes a single, uniform **REST API** under `<host>/api/`. This app applies
configuration over that API:

- **HTTP Basic auth** — every request carries an `Authorization: Basic` header. Two
  equivalent credential forms are supported:
  - a **user**: `username:password`
  - an **access token**: the token as the username with the literal password
    `token` (`<token>:token`) — the recommended form.
- **`X-Requested-By` CSRF guard** — Graylog rejects any non-GET request (create /
  update / delete) that lacks this header, so every write sends it automatically.
- **Self-signed TLS tolerated** — a self-hosted Graylog behind a self-signed
  certificate is accepted; the transport is protocol-aware (http/https), and the
  default REST port is 9000.

## Configuration types

| Type | Surface | Status |
|---|---|---|
| **Streams** | Graylog REST API (`/api/streams`, `/api/streams/{id}`, `/api/streams/{id}/resume`) | ✅ v0.1.0 |

The stream **title** is the stable identity used to upsert (create vs update) and
to detect drift. A newly created stream is **resumed** (Graylog creates streams
paused). Deploy snapshots the prior stream body so rollback can restore it — or
delete a stream it created.

**Rules** are authored as a JSON array of `{ field, type, value, inverted }`. The
rule `type` is an integer (from Graylog's `StreamRuleType`):

| type | meaning | needs a value? |
|---|---|---|
| 1 | match exactly | yes |
| 2 | match regular expression | yes |
| 3 | greater than | yes |
| 4 | smaller than | yes |
| 5 | field presence | no |
| 6 | contains | yes |
| 7 | always match | no |
| 8 | match input | yes |

`index_set_id` is required by Graylog to create a stream; leave the canvas field
blank and the deploy resolves the instance's **default** index set
(`GET /api/system/indices/index_sets`).

## Notes

Graylog REST API paths (`/api/system`, `/api/streams`, `/api/streams/{id}`,
`/api/streams/{id}/resume`, `/api/system/indices/index_sets`) and the create
response shape (`{ stream_id }`) should be **verified against a live Graylog
instance**. TLS verification is off by default (self-signed) and configurable via
the `verify_tls` setting.

### Planned — BYOL hosting

Bring-your-own-license **infrastructure hosting** for the full Graylog stack
(Graylog server + OpenSearch/Elasticsearch + MongoDB) is planned for a later wave.
It is intentionally **not** part of this release — no database, migrations, or
provisioning ship yet.

Apache-2.0.
