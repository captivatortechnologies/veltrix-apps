# Tanium

Manage [Tanium](https://www.tanium.com/) endpoint management as code. Author
Tanium **computer groups** and drive them through the Veltrix Security-as-Code
pipeline — validate, deploy, health check, drift detection and rollback — over
the **Tanium REST v2 API**.

- **Category:** Endpoint Management
- **Transport:** HTTPS (443), base `https://<server>/api/v2`, self-signed
  certificate tolerated (configurable via the `verify_tls` setting).

## What it manages

| Configuration type | What it does | API |
| --- | --- | --- |
| **Computer Groups** | Create / edit / delete Tanium computer groups — a `name` plus a filter expression (`text`) such as `Operating System contains Windows`, or an optional structured-filter JSON. Upsert by name. | `GET/POST /api/v2/groups`, `PUT/DELETE /api/v2/groups/{id}` |

## Authentication

The connection authenticates to the Tanium REST v2 API one of two ways. The
auth seam is isolated in `lib/taniumApi.ts` (`resolveTaniumSession`), and every
authenticated call carries a `session:` header:

1. **API token (preferred).** Create a token in Tanium under
   **Administration → Permissions → API Tokens** (shown once at creation). The
   token is sent verbatim as the `session:` header value — no login round-trip.
2. **Username + password.** The app POSTs
   `/api/v2/session/login` with `{ username, password }` and reads the returned
   session string from `data.session`, then sends it as the `session:` header.

Tanium does **not** use an `Authorization` / `Bearer` header — that returns 401.

Store the credential on the **Connections** page. Saving a connection also
registers the Tanium server as a `tanium-server` deploy target.

## Connectivity test

`GET /api/v2/system_status` after resolving a session. A login failure or a
401/403 proves reachability but flags the credential; any status below 500
confirms Tanium answered.

## Verify against a live Tanium

The REST v2 shapes here follow the documented v2 conventions and Tanium's public
integrations (Cortex XSOAR `Tanium_v2`, Splunk SOAR `taniumrest`, Tanium
Community). The following should be confirmed against a live Tanium before
production use:

- **`PUT /api/v2/groups/{id}` for an in-place update.** Public integrations
  delete + recreate a group rather than PATCH/PUT it; verify update semantics.
- **Structured filter JSON.** The verified authoring path is the plain-text
  `text` filter expression. The optional `filterJson` field maps to a `filters`
  spec whose exact shape (`and_flag`, per-clause `field`/`operator`/`value`) is
  not confirmed here — verify before relying on it.
- **Response envelope.** Responses are treated as possibly wrapped in
  `{ data: ... }`; both wrapped and bare forms are handled.

## Roadmap

- Newer **Tanium API Gateway (GraphQL)** path — noted but not implemented; v0.1.0
  targets REST v2.
- Additional configuration types (packages, saved questions, action groups).

## Notes

- No app-owned database or BYOL infrastructure in this foundation.
- TLS verification is off by default (on-premises appliances commonly ship a
  self-signed certificate); toggle with the `verify_tls` setting.
