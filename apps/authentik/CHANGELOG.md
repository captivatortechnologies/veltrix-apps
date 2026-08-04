# Changelog

All notable changes to the authentik app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.4.0 — 2026-08-04

Exhausts authentik's meaningful declarative config-as-code surface: eight new
configuration types (12 total), every type now carries a sidebar `group`, and
a full README **Coverage** section enumerates what is managed vs. what is
intentionally excluded and why. BYOL infrastructure from 0.3.0 is untouched.
`lib/authentikApi.ts` is reused unchanged by every new type (Bearer client,
page-number pager, `findByName`); it gains one generalization —
`findByField` — for the one resource whose upsert identity isn't `name`.

- **SAML Providers (`saml-providers`, group "Providers")** — name, flows, ACS
  URL, audience, SP binding, assertion/response signing, scope mappings, over
  `/api/v3/providers/saml/`. Upserts by name (server-assigned integer `pk`,
  same pattern as OAuth2/OpenID Providers). Signing/verification/encryption
  keypair references, SLS (logout) URL/binding, NameID/AuthnContextClassRef
  mapping overrides and validity-window overrides are dropped for now (real,
  writable fields authentik defaults when omitted).
- **Proxy Providers (`proxy-providers`, group "Providers")** — name, flows,
  mode (proxy / forward-auth single / forward-auth domain), internal/external
  host, upstream SSL validation, skip-auth path regexes, HTTP-Basic injection,
  cookie domain, scope mappings, over `/api/v3/providers/proxy/`. `certificate`
  (a keypair reference), JWT federation, and token-validity overrides are
  dropped for now.
- **LDAP Providers (`ldap-providers`, group "Providers")** — name, flows, base
  DN, uid/gid start numbers, search/bind mode, MFA support, scope mappings,
  over `/api/v3/providers/ldap/`. `certificate` and `tls_server_name` are
  dropped for now.
- **Scope Property Mappings (`scope-property-mappings`, group
  "Customization")** — name, requested scope name, consent description and the
  Python expression that computes the scope's claims, over
  `/api/v3/propertymappings/provider/scope/`. Upserts by name
  (server-assigned UUID). Unblocks a real dependency: a mapping's pk can be
  pasted into an OAuth2/OpenID Provider's Scope/Property Mappings field.
- **Policies (`policies`, group "Policies")** — Expression, Password and
  Reputation policies, each a genuinely distinct authentik model with its own
  endpoint (`/policies/expression/`, `/policies/password/`,
  `/policies/reputation/`), unified behind one config type with a `type`
  selector; upserts by name **within** the selected type's endpoint. Retyping
  an existing item creates a new policy under the new endpoint rather than
  migrating it — the prior one is left in place (documented in canvas.yaml).
- **Stages (`stages`, group "Flows & Stages")** — Identification, Password,
  Authenticator Validation and User Login stages, each its own endpoint
  (`/stages/identification/`, `/stages/password/`,
  `/stages/authenticator/validate/`, `/stages/user_login/`), unified behind one
  config type with a `type` selector; upserts by name within the selected
  type. A stage created here is immediately usable in authentik's own flow
  editor — **per-flow stage bindings (ordering, policies) are NOT authored**;
  see Coverage.
- **Sources (`sources`, group "Federation")** — OAuth and LDAP federation
  sources, each its own endpoint (`/sources/oauth/`, `/sources/ldap/`),
  unified behind one config type with a `type` selector; identity is the
  source's `slug` (a direct path key, like Applications/Flows — retrieves by
  identity, not list+match). `consumer_secret` / `bind_password` are
  `writeOnly: true` in authentik's own schema — never read back for drift or
  rollback, sent only when the canvas item declares a non-blank value.
- **Brands (`brands`, group "System")** — the per-domain tenant branding and
  default authentication/invalidation/recovery flow record, over
  `/api/v3/core/brands/`. Upserts by **domain** (server-assigned UUID path
  key) via a new generic `findByField` helper in `lib/authentikApi.ts`
  (`findByName` is now a thin wrapper over it). Secondary flow overrides,
  custom CSS/map tiles, `default_application` and certificate references are
  dropped for now.
- **Re-grouped every configuration type** for the sidebar: Applications →
  "Applications"; OAuth2/OpenID, SAML, Proxy, LDAP Providers → "Providers";
  Groups → "Directory"; Flows and Stages → "Flows & Stages"; Scope Property
  Mappings → "Customization"; Policies → "Policies"; Sources → "Federation";
  Brands → "System".
- **README Coverage section** — every authentik config surface, managed vs.
  intentionally excluded and why (see README for the full table): user
  lifecycle (provisioned via Sources/SCIM sync, not hand-authored), API
  tokens/app passwords (credentials, not config), certificates/keypairs
  (private key material, referenced by pk only), per-flow stage bindings and
  policy bindings (graph-shaped ordering/conditions, not a flat item list),
  outposts (infrastructure lifecycle, not REST config), and read-only/runtime
  surfaces (events, tasks, system health, RBAC). Also notes legitimate
  follow-up work not yet built: RAC/RADIUS/SCIM providers and the
  non-scope property-mapping subtypes (SAML/LDAP/notification/…) — same
  pattern, different endpoint, deferred for scope discipline rather than
  infeasibility.

> Cited against `https://api.goauthentik.io/schema.yml` (fetched directly and
> grepped for every schema referenced above), plus the endpoint reference
> pages at `https://api.goauthentik.io/reference/...`. See the README's
> References section for the exact schema names and endpoint pages per config
> type.

## 0.3.0 — 2026-08-02

BYOL infrastructure hosting for the authentik stack — the app now owns
end-to-end stack provisioning alongside REST API configuration authoring,
mirroring the node_tiers-native BYOL model (structurally replicated from
`apps/greenbone`).

- **Infrastructure console** — a new "Infrastructure" page (SDK
  `<ByolInfrastructureManager>` over the app-owned `/byol` routes, Settings nav
  group) to define a stack's topology, deploy it to a Veltrix-hosted or your
  own cloud account (BYOC), preview a Terraform-style plan, and manage its
  lifecycle (start / stop / restart / destroy).
- **node_tiers-native topology** — two user-scalable node tiers, **Server
  nodes** (authentik server — web/API, the ALB target, min 1) and **Worker
  nodes** (authentik worker — background tasks, min 1), persisted ONLY in a
  `node_tiers` JSONB column (no legacy count columns). Both tiers run the
  **same container image**; only the startup command differs (`server` vs
  `worker`). The server adds the fixed supporting service — **PostgreSQL**
  (authentik's database) — plus the foundation (network, load balancer, DNS,
  TLS, secrets) automatically. A single-node deployment collapses to one
  all-in-one box.
- **Declarative InfraSpec** (`infra/spec.ts`) — authentik server on internal
  HTTP 9000 (ALB target, TLS terminated at the load balancer) + HTTPS 9443
  (direct/admin), PostgreSQL 5432 as a peer/self rule, WAF on, no object
  storage. Composes the SAME generic OpenTofu modules as every other BYOL app
  purely by declaring data.
- **Provisioning + usage foundation** — resource plan, deployment runs +
  ordered steps, a lifecycle state-event log and a daily node-hours usage
  ledger, in two `authentik_`-prefixed migrations (`002_authentik_byol.sql`,
  `003_authentik_byol_usage.sql`). The existing REST API configuration seam
  (`lib/authentikApi.ts`) is untouched.

> **⚠ Researched deviation from the initial brief — no Redis.** The task
> template (mirroring `apps/greenbone`'s manager/scanner + PostgreSQL + Redis
> shape) called for a PostgreSQL + Redis data tier. Verification against
> official authentik sources found this to be **outdated for current
> authentik**: the 2025.10 release notes state "In previous versions,
> authentik used Redis for caching, tasks, the embedded proxy outpost's
> session store, and WebSocket connections. Since 2025.8, tasks were migrated
> to use Postgres. With this release we've also migrated caching, the embedded
> outpost, and WebSocket to Postgres, fully removing the need for Redis."
> (https://docs.goauthentik.io/releases/2025.10/ — "Breaking changes"). This is
> corroborated by the CURRENT official `docker-compose.yml`
> (https://docs.goauthentik.io/compose.yml, tag `2026.5.6` at research time)
> and the official Helm chart's `values.yaml`
> (https://raw.githubusercontent.com/goauthentik/helm/main/charts/authentik/values.yaml)
> — neither references Redis anywhere. The topology was built WITHOUT Redis
> accordingly, rather than modeled to match a template shape that no longer
> reflects authentik's real architecture. See `lib/byolTopology.ts` for the
> full citation trail.
>
> Also verified: authentik's `server` and `worker` run from the **same**
> container image (`ghcr.io/goauthentik/server`), differing only by startup
> command (`server` vs `worker`) — confirmed via the official
> `docker-compose.yml`. Health checks use `GET /-/health/live/` and
> `GET /-/health/ready/` on the server's HTTP port (9000) — confirmed via the
> official Helm chart's `values.yaml` (`server.livenessProbe`/`readinessProbe`).
> The worker exposes no ports (its own k8s probes use `exec: [ak, healthcheck]`,
> not HTTP).
>
> **Flagged as reasonable defaults to verify**: exact compute/instance sizing
> per tier, and the ALB→9000(HTTP)/termination-at-LB choice vs. forwarding
> straight to the server's native HTTPS (9443) — both are conventional but not
> mandated by authentik's own docs; verify against your scale and TLS posture
> before treating this as production-grade.

## 0.2.0 — 2026-08-02

Three new configuration types, plus a sidebar `group` on every configuration
type (including 0.1.0's Applications, now `group: "Applications"`). All reuse
`lib/authentikApi.ts` unchanged (the Bearer client + the page-number pager).
BYOL infrastructure for authentik is **not** part of this release — config
types only.

- **OAuth2/OpenID Providers (`oauth2-providers`, group "Providers").** Manage
  authentik OAuth2/OpenID Providers — name, authorization/invalidation flow (by
  Flow UUID pk), client type/id, signing key, redirect URIs and scope
  (property) mappings — over `/api/v3/providers/oauth2/`. Unlike Applications,
  a provider's API path key is a server-assigned integer `pk` with no
  create-time identity, so this type upserts by **name** (list `?name=` →
  exact match → `PATCH`/`POST`) via a new shared `findByName` helper added to
  `lib/authentikApi.ts`. This **unblocks the Applications → Provider linkage**
  flagged in 0.1.0: deploy a provider here, then paste its pk into an
  Application's `provider` field.
  - `client_secret` is never read, sent, or captured — treated as write-only,
    the same posture the platform's `wiz` app takes with a generated secret.
  - `invalidation_flow` is authored even though it wasn't in the original spec
    — the schema's `OAuth2ProviderRequest.required` includes it; a create
    without it is rejected by authentik.
  - Redirect URIs are authored as one URL per line, translated to authentik's
    real `{ matching_mode: "strict", url, redirect_uri_type: "authorization" }`
    shape — regex matching and logout-type entries are **dropped** from the UI
    for v0.2.0.
  - `client_id` / `signing_key` / `property_mappings` are opt-in-managed: left
    blank they are omitted from every request (never cleared), and drift is
    only asserted for them when declared.
  - Flow references are authored as the target Flow's **UUID pk**, not its
    slug — matching authentik's own FK representation. Live resolution from a
    Flow's slug (its own identity in this app's Flows type) is **flagged** as
    a follow-up (a `remote-select` sourced from `GET /flows/instances/`).
- **Groups (`groups`, group "Directory").** Manage authentik Groups — name,
  the superuser flag, an optional parent group and custom attributes — over
  `/api/v3/core/groups/`. Also upserts by name (server-assigned UUID path key).
  - The live field is `parents` (an array); this release authors a single
    optional parent, sent as a one-element array only when declared —
    multi-parent authoring is **dropped** for now.
  - Group membership (`users`) and RBAC `roles` are real `GroupRequest` fields
    that are **dropped** from every request body — this type never touches
    membership or role assignment.
- **Flows (`flows`, group "Flows").** Manage authentik Flows — name, slug,
  title, designation and an optional required-authentication level — over
  `/api/v3/flows/instances/`. Like Applications, a flow's `slug` is both its
  identity and API path key, so this type retrieves by identity directly
  (`GET .../{slug}/` → `200`/`404` → `PATCH`/`POST`).
- All three types ship the full handler set (validate, deploy, rollback,
  healthCheck, driftDetect, getStatus) and full `__tests__` coverage of
  validate + the pure `_shared.ts` helpers (network-free, matching the 0.1.0
  test style).
- Client: Setup Guide now covers all four configuration types and their token
  scopes; Overview is unchanged (generic, fed by `/meta`).

> Cited against `https://api.goauthentik.io/schema.yml` (fetched directly);
> see the README's References section for the exact schema names and endpoint
> reference pages per config type.

## 0.1.0 — 2026-08-02

Initial release — foundation + first config type.

- **Applications** config type — create / edit / delete authentik Applications
  (name, slug, an optional bound provider by existing pk, policy engine mode,
  UI group and display metadata) over the authentik Core REST API
  (`/api/v3/core/applications/`), with validate / deploy (upsert by slug,
  retrieved directly via `GET .../applications/{slug}/`) / rollback (restore
  prior managed fields or delete a created application) / health-check /
  drift-detect / status.
- **Connectivity test** — verifies the endpoint + a static API token with
  `GET /api/v3/core/applications/?page_size=1`, `Authorization: Bearer <token>`.
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API
  token → connection → author), and Connections (wraps the SDK
  `ConnectionsManager` for a self-hosted authentik instance; saving a
  connection registers `authentik-server` as a deploy target).

> authentik authenticates with a single static API token (no OAuth exchange) —
> the connection stores it as the credential's API token; no username is
> required. A self-hosted instance's self-signed certificate is tolerated
> unless the app's `verify_tls` setting is turned on.

> **Provider linkage deferred.** `provider` references an existing authentik
> Provider (OAuth2/OIDC, SAML, proxy, LDAP, …) by numeric pk — this release
> does not create or manage Providers themselves. That ships as its own
> configuration type in a later wave; an invalid/nonexistent pk is rejected by
> authentik at deploy time.
