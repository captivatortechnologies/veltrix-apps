# Aqua Security

Manage **Aqua Security** (CNAPP) as code — image, host, function and
Kubernetes assurance policies, container and host runtime policies, firewall
policies, application scopes, and Enforcer Group protection configuration.
Author each configuration in the Configuration Canvas and drive it through
the Security-as-Code pipeline — validate, deploy, health check, drift
detection and rollback — over the **Aqua CSP/Enterprise Console REST API**.

Aqua is customer-hosted (self-hosted, or a single-tenant Aqua-hosted Console —
the same product and API either way), so there is **no BYOL infrastructure and
no app database** for this app.

## What it manages

| Group | Configuration type | Aqua object | API surface |
| --- | --- | --- | --- |
| Assurance Policies | **Image Assurance Policies** | Vulnerability/malware/license/secrets/CIS gates for container images | `/api/v2/assurance_policy/image` |
| Assurance Policies | **Host Assurance Policies** | CIS/vulnerability/hardening gates for the underlying host OS | `/api/v2/assurance_policy/host` |
| Assurance Policies | **Function Assurance Policies** | Vulnerability/malware/license/secrets gates for serverless (FaaS) packages | `/api/v2/assurance_policy/function` |
| Assurance Policies | **Kubernetes Assurance Policies** | Image/label/CIS gates for Kubernetes workloads | `/api/v2/assurance_policy/kubernetes` |
| Runtime Policies | **Container Runtime Policies** | Drift prevention, allow-lists, malware scan, reverse-shell/network controls for running containers | `/api/v2/runtime_policies` (`type=container`) |
| Runtime Policies | **Host Runtime Policies** | Executable/OS-user allow-lists, malware scan, file-integrity, reverse-shell detection for the host | `/api/v2/runtime_policies` (`type=host`) |
| Network Security | **Firewall Policies** | ICMP/metadata-service blocking, inbound/outbound network rules | `/api/v2/firewall_policies` |
| Access & Scope | **Application Scopes** | Named image/workload/infrastructure filters referenced by every policy type above | `/api/v2/access_management/scopes` |
| Enforcers | **Enforcer Groups** | Runtime/network/host/image protections + orchestrator targeting for an Enforcer group | `/api/v1/hostsbatch` |

Every type upserts **by name** (Enforcer Groups upsert by an operator-chosen
`groupId`, Aqua's own `id`/identity field for that object — see below).
Assurance and Runtime Policies additionally support an `enabled: false`
toggle, modeled as "not present" — the policy is deleted if it exists.
Firewall Policies, Application Scopes and Enforcer Groups have no such toggle
in Aqua's own model — remove the canvas item to remove the object.

## Connection & credentials

A connection is an **Aqua Console** addressed by its **base URL** plus a
dedicated **Aqua user id/email + password**.

- **Console base URL** — your Aqua Console address, e.g.
  `https://aqua.example.com`. Set it as the connection endpoint.
- **Aqua user** — Aqua's own Terraform-provider docs recommend creating "a
  custom user, role and permission set (with API Only permissions)" dedicated
  to automation, rather than reusing a personal admin login. Store the user's
  id/email as the credential username and password as the credential secret.

Auth is a **session-token login**, not a static API key: this app calls
`POST /api/v1/login` with `{"id": "<user>", "password": "<password>"}`,
caches the returned JWT, and sends it as `Authorization: Bearer <token>` on
every subsequent call — re-logging in once if a token is rejected (401). This
mirrors the official Aqua Terraform provider's own token-auth flow exactly
(`client.GetCspAuthToken` / `NewClientWithTokenAuth` in
`terraform-provider-aquasec`'s `client/client.go`).

The **Test** button on the Connections page logs in and then calls
`GET /api/v2/access_management/scopes/<probe-name>` — a 200 or 404 both
confirm the Console resolved and the credential authenticated; a 401/403
flags the credential.

### Aqua SaaS (cloud.aquasec.com) — not modeled in v0.1.0

Aqua also offers a fully-hosted, multi-region SaaS console
(`cloud.aquasec.com` and regional variants). Once authenticated, its REST
surface for the object types above is the **same** API this app already
targets — but *reaching* that surface needs one extra hop this app does not
implement yet: `POST <region-token-url>/v2/signin` (or an API-key + HMAC
exchange at `/v2/tokens`), followed by resolving the tenant's actual API host
via `GET <region>/v1/envs` (the `ese_url` in the response) before any policy
call can be made. A customer on a self-hosted or single-tenant Aqua-hosted
Console — this app's target — skips that resolution step entirely (its
`aqua_url` IS the API host). Multi-region SaaS auth is a clean, self-contained
follow-up (a `resolveSaasCredential`/`AuthenticateWithSaas` sibling to the
existing login path in `lib/aquasec.ts`) rather than a v0.1.0 blocker.

## Coverage (v0.1.0)

Coverage was researched against the **official**
[`terraform-provider-aquasec`](https://github.com/aquasecurity/terraform-provider-aquasec)
Go client (`client/*.go` — the source of truth for the actual REST contract;
there is no public OpenAPI spec for this API), its resource docs
(`docs/resources/*.md`), and the provider's own `docs/index.md` (auth model).
Every endpoint and field name cited in this app's `lib/aquasec.ts` and each
config type's shared-logic module is traced to a specific Go source file.

### Managed declarative configuration

| Configuration type | Endpoint | Identity / upsert strategy |
| --- | --- | --- |
| Image / Host / Function / Kubernetes Assurance Policies | `/api/v2/assurance_policy/<type>` | by `name` (one endpoint family, `<type>` path segment) |
| Container / Host Runtime Policies | `/api/v2/runtime_policies` | by `name` (one endpoint, `type` body field) |
| Firewall Policies | `/api/v2/firewall_policies` | by `name` |
| Application Scopes | `/api/v2/access_management/scopes` | by `name` |
| Enforcer Groups | `/api/v1/hostsbatch` | by operator-chosen `groupId` (Aqua's own `id` field — not auto-generated, so this app can create with a known id up front) |

**Curated field subset, not the full wire schema.** Aqua's Assurance Policy
and Runtime Policy objects are large (the Go client's `AssurancePolicy` struct
alone carries ~90 fields; `RuntimePolicy` is comparably large) — this app
models a curated, high-value subset per type (identity/scope, enforcement,
vulnerability/CVE gates, malware/sensitive-data, packages/licenses, CIS
benchmarks, labels, and a scope expression) rather than every field, matching
this codebase's convention on other large upstream schemas (e.g. Splunk
inputs, CrowdStrike policies). Every write is a **read-modify-write** in
spirit at the API boundary — Aqua's PUT replaces the object with exactly the
body sent, so a field this app does not model is **not preserved** on update;
it resets to that field's zero value. This is called out explicitly rather
than silently: operators should not hand-edit fields outside this app's canvas
on a policy this app manages.

**Application Scopes — a scoped-down category tree.** Aqua's full scope model
covers artifacts (image/function/cf/codebuild), workloads
(kubernetes/os/cf) and infrastructure (kubernetes/os) — six leaf categories.
This app models the three highest-value dimensions for a container/CNAPP tool
— **image artifacts**, **Kubernetes workloads** and **Kubernetes
infrastructure** — as a focused first release. Serverless-function,
Cloud-Foundry/Tanzu and bare-VM (OS) workload/infrastructure scoping are a
documented future addition (the `categories` object already round-trips
whatever this app does not set, so adding a category later is additive, not
breaking).

**Firewall Policies — network rules as JSON.** Aqua's inbound/outbound
network rules are each a **list** of `{allow, resourceType, portRange,
resource}` objects. This canvas schema has no repeatable-sub-group field type
(only flat fields, `tags` lists and `keyvalue` maps), so each direction is
authored as a JSON array in a textarea — the same escape-hatch convention
this codebase uses elsewhere for genuinely nested, multi-field list data
(e.g. `rapid7`'s `report_config_json`). `validate.ts` parses and rejects
malformed JSON, an unknown `resourceType`, or a missing `resource` on a
`custom` rule before it ever reaches Aqua.

**Enforcer Groups — configuration only, never installation.** This config
type manages a group's *protection configuration* (which controls are
active, orchestrator targeting, allow-lists, scheduled-scan settings) — never
the install token, install command, or the act of registering an Enforcer
into the group. Those are one-shot, imperative, host-specific bootstrap
actions, not steady-state desired-state config (see "Intentionally excluded"
below).

### Intentionally excluded (v0.1.0) — future Coverage

- **Registries integration config** (`aquasec_integration_registry`,
  `/api/v2/registries`) — deferred, not dropped. Aqua's `Registry` object
  embeds a plaintext `username`/`password` for the upstream image registry
  directly in the SAME JSON body as its config (auto-pull schedule, prefixes,
  scanner assignment, etc.) — there is no separate secret-reference field to
  point at a Veltrix-managed credential instead. A future release needs a
  deliberate design for excluding those two fields from every read-modify-write
  and drift comparison (write-only, never diffed) before this is safe to ship;
  doing it without that care would either leak a credential into `rollbackData`
  or produce permanent false-positive drift on every run.
- **Custom compliance checks** (`aquasec_assurance_custom_script`,
  `POST /api/v2/image_assurance/user_scripts`) — a Rego/OPA script object
  referenced by name from `custom_checks`/`kubernetes_controls` on an
  Assurance Policy. A clean, valuable addition, deferred to keep this first
  release's scope to the ~9 clearest, highest-value types; the assurance
  policy schema already has a `custom_checks_enabled` toggle for when this
  ships.
- **Permission Sets & Roles** (`aquasec_permissions_sets` /
  `aquasec_role`, `/api/v2/access_management/permissions` /
  `/api/v2/access_management/roles`) — Aqua's own RBAC layer (who can do
  what). Deferred alongside Registries/Custom-Checks for v0.1.0 scope, not a
  permanent exclusion — these are genuinely declarative and a natural
  "service/user-access rules" addition.
- **Gateways** (`aquasec_gateways` data source) — **read-only in the official
  provider**: there is a `dataSourceGateways()` but **no**
  `resourceGateway()` in the provider's `ResourcesMap`/`DataSourcesMap`
  (`aquasec/provider.go`). Gateways are provisioned by installing the Aqua
  Gateway component itself, not by a config-as-code write API — there is
  nothing for this app to create, update or delete.
- **Aqua SaaS multi-region auth** — see "Connection & credentials" above.
- **One-shot scans, vulnerabilities, audit/event logs, incidents** — read-only
  or imperative findings, not durable desired-state configuration (mirrors
  every other Veltrix app's exclusion of scan results / audit trails).
- **Secret material of any kind** (registry credentials, API keys, Enforcer
  install tokens) — this app never reads or writes secret values themselves,
  only the configuration objects that reference them by name.
- **Agent/Enforcer installers** — the install script/command/container image
  for deploying an Enforcer onto a host is a one-shot host-bootstrap action,
  not steady-state Aqua-side configuration (see "Enforcer Groups" above).
- **Users, SSO, and Aqua-the-organization-level administration** —
  account/platform-wide administration outside this app's per-Console
  connection boundary, mirroring how other Veltrix apps exclude org-wide
  administration from a connection-scoped canvas.

## Verification notes

Every endpoint, request/response shape and field name in this v0.1.0 release
was traced directly to a specific file in `terraform-provider-aquasec`'s
`client/` package (the Go client backing the official Terraform resources)
rather than inferred from Terraform argument docs alone. The exact source
file is cited in `lib/aquasec.ts`'s module doc and in each config type's
`deploy.ts`/`_shared.ts` header comment. As with every app in this
repository, verify against a live Aqua Console before production use —
in particular the Enforcer Type / Orchestrator Type free-text fields (see
`config-types/enforcer-groups/canvas.yaml`), whose exact accepted values were
not confirmed against a live Console.
