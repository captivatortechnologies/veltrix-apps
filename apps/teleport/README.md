# Teleport

Manage [Teleport](https://goteleport.com/) (Gravitational) infrastructure access & privileged access
management configuration as code through the **Teleport Proxy web API** — the same JSON+YAML surface
the Teleport Web UI itself uses. Author configurations in the platform's Configuration Canvas and
deploy them through the Security-as-Code pipeline — validate, deploy, health check, drift detection
and rollback are handled per configuration type.

## Why the Proxy web API, not the Terraform provider's transport

Teleport's primary automation surface is the **Auth Service gRPC API over mutual TLS** — this is what
`tctl`, Machine ID, and the official `terraform-provider-teleport` all speak. Verified directly against
`gravitational/teleport`'s `integrations/terraform/provider/provider.go`: its schema is `addr` plus
either an identity file (`tctl auth sign --format=file --user=terraform --out=...`), a raw
cert/key/CA triple, or a native Machine ID join, dialed with `google.golang.org/grpc`
(`github.com/gravitational/teleport/api/client`).

That transport is not reachable from a plain in-process `fetch()` — there is no JSON/HTTP transcoding
gateway for it, and hand-rolling protobuf wire encoding for a dozen undocumented-field-number services
would not be a responsible substitute for generated client code.

What **is** reachable from `fetch()`, and genuinely a JSON+YAML REST surface, is the Teleport
**Proxy's web API** (`/v1/webapi/*`) — the same routes the Teleport Web UI itself calls to manage
roles, auth connectors, trusted clusters, Machine ID bots, databases, and discovery configs. Every
route and JSON shape this app uses was verified directly against
[`gravitational/teleport@master`](https://github.com/gravitational/teleport) source (see citations
per configuration type below), not assumed.

## Credentials

The app authenticates as a **local Teleport user** using the same login flow the Teleport Web UI's
login form uses:

`POST /v1/webapi/sessions/web` with `{"user", "pass", "second_factor_token"}` (verified against
`lib/web/apiserver.go`'s `createWebSession` / `CreateSessionReq`) returns a bearer token
(`{"type":"bearer","token":"..."}`) and sets a `__Host-session` cookie (`lib/web/session/cookie.go`).
Every subsequent request needs **both** the `Authorization: Bearer <token>` header and that cookie
(`AuthenticateRequest`).

WebAuthn cannot be satisfied headlessly, so the connecting user must have a **TOTP** device enrolled
if the cluster enforces a second factor (the overwhelmingly common case — treat "no second factor" as
a test-cluster-only configuration). The app computes the current TOTP code locally
(`lib/totp.ts` — RFC 6238 over Node's built-in `node:crypto`, no external OTP dependency) from a
base32 seed you provide.

1. Create a dedicated local Teleport user (e.g. `tctl users add veltrix-automation --roles=<a role
   scoped to what this app manages>`) and enroll a TOTP device for it.
2. Store its credentials as a Veltrix credential:

| Veltrix credential field | Teleport value |
| --- | --- |
| Username | The local user's username |
| API token | A JSON bundle: `{"password": "...", "totpSecret": "<base32 TOTP seed>"}` |

   (A bare password with no `totpSecret` is also accepted, but only works when the cluster enforces no
   second factor.) This bundles two secrets into one platform credential field — the same pattern
   `apps/velociraptor/lib/velociraptorApi.ts` uses for its api-client config (CA cert + client cert +
   client key as one secret) rather than inventing a new platform credential shape.
3. Register a **`teleport-cluster`** component whose hostname is your Teleport **Proxy address**
   (e.g. `teleport.example.com:443`), and attach the credential.

For the three cluster-scoped configuration types (Machine ID Bots, Databases, Discovery Config), the
app auto-detects the root cluster's name via `GET /v1/webapi/sites` — set the **Cluster Name** app
setting only to target a specific leaf/trusted cluster explicitly.

## What it manages

| Configuration type | Teleport resource / API | Verified route(s) |
| --- | --- | --- |
| Roles | RBAC roles (`kind: role`) | `GET/POST/PUT/DELETE /v1/webapi/roles[/{name}]` |
| GitHub Connectors | GitHub SSO auth connectors (`kind: github`) | `GET/POST/PUT/DELETE /v1/webapi/github[/{name}]` |
| Trusted Clusters | Cluster federation (`kind: trusted_cluster`) | `GET/POST /v1/webapi/trustedcluster`, `PUT/DELETE /v1/webapi/trustedcluster/{name}` |
| Machine ID Bots | Bot identities (roles/traits/TTL) | `GET/POST /v1/webapi/sites/{site}/machine-id/bot`, `PUT` (v3) `/DELETE .../bot/{name}` |
| Databases | Dynamic database resource registrations | `GET/POST /v1/webapi/sites/{site}/databases`, `PUT .../databases/{name}` |
| Discovery Config | Cloud auto-discovery (AWS/Azure/GCP/Kube matchers) | `GET/POST/PUT/DELETE /v1/webapi/sites/{site}/discoveryconfig[/{name}]` |

Three types (Roles, GitHub Connectors, Trusted Clusters) let you author only the resource's `spec:`
body in a textarea — the app wraps it into the full `kind`/`version`/`metadata.name`/`spec` envelope
Teleport's web API expects (`lib/resourceYaml.ts`), the same "author just the body" pattern
`apps/hashicorp-vault/config-types/policies` uses for raw HCL. This is verified against
`lib/web/resources.go`: these three resources are sent/received as a full resource YAML string inside
a `{"content": "..."}` JSON envelope (`ui.ResourceItem`), exactly what `tctl create -f role.yaml`
would produce — genuinely config-as-code native, just reached over the Proxy's JSON surface instead
of `tctl`/gRPC.

## Coverage

This release covers six of Teleport's clearest, most valuable **declarative, round-trippable**
resources reachable via the Proxy web API. What's deliberately out of scope, and why:

| Candidate | Why it's not in this release |
| --- | --- |
| OIDC / SAML auth connectors | Enterprise-licensed and implemented in Teleport's closed-source `teleport.e` repository — no verifiable route exists in the public `gravitational/teleport` source this app was built against. Only the GitHub connector (present in the OSS repo, `lib/web/resources.go`) is covered. |
| Access Lists, Login Rules, Access Monitoring Rules, Device Trust | Enterprise-licensed features. A comprehensive route search of `lib/web/apiserver.go`'s `bindDefaultEndpoints` found no `/v1/webapi/*` route for any of these — they are gRPC/`tctl`-only, not exposed through the Proxy's JSON surface this app can reach. |
| Cluster Networking Config, Cluster Auth Preference, Session Recording Config | Cluster-wide singleton settings. Same finding as above — not exposed as editable JSON via the Proxy web API, only via `tctl`/gRPC. |
| Locks | A real dynamic resource (`PUT /v1/webapi/sites/{site}/locks`), but Teleport server-assigns its name (a random UUID) on every create — there is no upsert-by-name. Redeploying an unchanged canvas item would mint a *new* lock rather than converge to one, the same reason this catalog's config-as-code apps exclude one-shot session/access-request approvals. It is a security *action*, not a stable declarative object. |
| Provision/join tokens (incl. bot join tokens) | Secret join material, explicitly excluded the way every other app in this catalog treats one-time-use credential secrets. |
| Kubernetes clusters, Applications (App Access) | Verified read-only in the Proxy web API — `lib/web/apiserver.go` registers only `GET` routes for these (`clusterKubesGet`, `getAppDetails`); no create/update/delete route exists for either. |
| Git Servers (GitHub org access) | A real, verified resource (`PUT/GET/DELETE .../gitservers`), but currently GitHub-only and has no `LIST` route — narrow enough to defer to a focused future pass rather than dilute this release. |
| Users, Sessions, Notifications, per-user MFA devices | Per-user lifecycle/inventory, not org-level declarative config — the same reasoning every IAM app in this catalog applies to its own Users-shaped endpoints. |
| Cluster Auth export, CA rotation | Certificate-authority material — the same "certificate ids as external references, not authored here" reasoning `ping-identity` applies to its own key-management endpoints. |

Verified against [`gravitational/teleport@master`](https://github.com/gravitational/teleport) as of
2026-08 — every route cited above was read directly from `lib/web/apiserver.go`'s route table and the
corresponding handler file, not assumed from documentation.

### Known limitations (honest, not stubs)

- **Databases has no rollback-delete.** The Proxy web API registers no `DELETE` route for a database
  resource (`lib/web/apiserver.go` has `GET`/`POST /v1/webapi/sites/{site}/databases` and
  `GET`/`PUT .../databases/{name}`, no `DELETE`). Rolling back a database this app *created* restores
  what it can and reports the ones that need manual removal (`tctl rm db/<name>`) rather than silently
  leaving them unexplained.
- **Database CA certificate and AWS RDS metadata are write-only.** `lib/web/ui/server.go`'s
  `MakeDatabase` (the read-back shape) exposes `protocol`/`uri`/`labels` but not the CA certificate or
  a verified AWS RDS metadata shape — drift detection and rollback cover the three read-back fields;
  redeploy to correct the other two if they need to change.
- **GitHub connector `client_secret` and trusted cluster `token` are sensitive fields inside the
  spec body.** Teleport's single-connector GET *does* include `client_secret` (the Web UI needs it to
  render an edit form) unlike the list endpoint, which omits it. Drift detection transiently holds
  these values in memory to compare structural drift — never logged, displayed, or persisted beyond
  that comparison.
- **Machine ID bot read-back JSON casing.** `GET .../machine-id/bot/{name}` returns the raw
  `machineidv1.Bot` protobuf message directly (unlike every other handler in this app, which returns a
  hand-written JSON struct) — its exact wire casing was not independently verified against a live
  cluster, so `lib/deploy.ts` reads both plausible casings (`max_session_ttl` / `maxSessionTtl`)
  defensively rather than assuming one.

## Health check

Each configuration type's health check first confirms the session can log in and list that resource
type (a call that never requires a specific declared item to exist), then confirms every item declared
in the canvas is still present in Teleport.

## References

- Teleport documentation: <https://goteleport.com/docs/>
- Teleport source (route table + handlers this app was verified against):
  <https://github.com/gravitational/teleport/blob/master/lib/web/apiserver.go>,
  <https://github.com/gravitational/teleport/tree/master/lib/web>
- Official Terraform provider (the gRPC/mTLS transport this app deliberately does NOT use, and why):
  <https://github.com/gravitational/teleport/tree/master/integrations/terraform>,
  <https://goteleport.com/docs/reference/infrastructure-as-code/terraform-provider/>
