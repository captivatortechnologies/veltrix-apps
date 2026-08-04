# Twingate (Veltrix app)

Manage [Twingate](https://www.twingate.com) (ZTNA / Zero Trust Network Access)
configuration as code through the **Twingate GraphQL API**, driven by the
Veltrix Security-as-Code pipeline (validate → deploy → health check → drift
detect → rollback).

## What it manages

| Configuration type | Sidebar group | Twingate object | GraphQL operations |
| --- | --- | --- | --- |
| **Resources** (`resources`) | Network | Resources (private apps/hosts/subnets, protocols and Group access) | `resources` (list), `resource` (read), `resourceCreate`, `resourceUpdate`, `resourceDelete` |
| **Remote Networks** (`remote-networks`) | Network | Remote Networks (name, location, network type) | `remoteNetworks` (list), `remoteNetworkCreate`, `remoteNetworkUpdate`, `remoteNetworkDelete` |
| **Groups** (`groups`) | Access | Groups (`MANUAL` only — name, active state, Resource access) | `groups` (list), `groupCreate`, `groupUpdate`, `groupDelete` |
| **Service Accounts** (`service-accounts`) | Access | Service Accounts (name only) | `serviceAccounts` (list), `serviceAccountCreate`, `serviceAccountUpdate`, `serviceAccountDelete` |
| **Connectors** (`connectors`) | Network | Connectors (name, Remote Network placement, status notifications) | `connectors` (list), `connectorCreate`, `connectorUpdate`, `connectorDelete` |
| **DNS Filtering Profiles** (`dns-filtering-profiles`) | Security | DNS Filtering Profiles (priority, domain lists, content/security/privacy categories, Group assignment) | `dnsFilteringProfiles` (list), `dnsFilteringProfile` (read), `dnsFilteringProfileCreate`, `dnsFilteringProfileUpdate`, `dnsFilteringProfileDelete` |

Every type reconciles by **name** and targets a `twingate-network` component.

### Resources

A Resource is a private application, host or subnet reachable through a
Remote Network's Connector(s). Each declares:

- `address` — the hostname, IP or CIDR the Connector routes to
- `remote_network_name` — the Remote Network it belongs to, matched by
  **name** against the live tenant and resolved to its id at deploy/drift time
- TCP/UDP protocol policy (`ALLOW_ALL` / `RESTRICTED` / `DENY_ALL`), with port
  lists enforced only under `RESTRICTED`, and an ICMP toggle
- `group_names` — Twingate **Groups** granted access, matched by name and
  resolved to ids

An updated resource's prior full state (address, remote network, protocols,
alias, visibility flags, group access) is captured for rollback.

### Remote Networks

A Remote Network is the routing boundary a Connector (and the Resources it
exposes) belongs to. RemoteNetwork is a concrete GraphQL type (unlike
Resource, no inline-fragment indirection), and its managed state
(`name`/`location`/`network_type`/`is_active`) is small enough that the list
query alone carries everything a deploy needs.

### Groups

A Group grants its members access to the Resources assigned to it. Twingate
itself sets a group's `type` — `MANUAL` (created via the API/console),
`SYNCED` (from a connected IdP) or `SYSTEM` (Twingate built-ins, e.g.
"Everyone"). This app reconciles by name **only among `MANUAL` groups**; a
same-named `SYNCED`/`SYSTEM` group is never modified — deploy aborts with a
clear error, and drift reports it as critical, rather than silently skipping
or duplicating it. `resource_names` grants Resource access
(full-replacement); **user membership is out of scope** (see below).

### Service Accounts

A Service Account is a non-human identity. Its only mutable field is `name`;
everything else (its **keys**, and granting it access to Resources via
`serviceAccountIds`) is out of scope — see "Scope" below.

### Connectors

A Connector provides connectivity to a Remote Network. Creating it here only
registers the Connector *object* in Twingate — deploying the actual Connector
process still requires a Connector **token** pair, generated directly in
Twingate (see "Scope" below). A Connector's Remote Network is set on create
only; `connectorUpdate` has no such argument, so a declared move fails closed
rather than being silently ignored.

### DNS Filtering Profiles

A DNS Filtering Profile controls website access via DNS for the Groups it is
assigned to (requires DNS filtering to be enabled on the tenant's plan).
`dnsFilteringProfileCreate` accepts only `name` — every other field (priority,
fallback method, allow/deny domain lists, and the full set of
content/security/privacy category flags) is applied via a follow-up
`dnsFilteringProfileUpdate`, which this app always issues immediately after a
create.

### Scope

Deliberately **out of scope** for this app version rather than guessed at
(see the citations in each config type's `_shared.ts`):

- **Specialized resource kinds.** Twingate has SSH, Kubernetes and Web App
  resource kinds with their own `sshResourceCreate` /
  `kubernetesResourceCreate` / `webAppResourceCreate` mutations — only the
  base (`NetworkResource`) kind is managed here.
- **Resource fields beyond the base spec.** `securityPolicyId`, `tags`,
  `accessPolicy`/`approvalMode`/`approverGroupIds` (Access Policies aren't yet
  a Veltrix config type) and `serviceAccountIds` access.
- **Group user membership.** Groups are usually populated by IdP sync or
  direct invitation, not Infrastructure-as-Code; only Resource access
  (`resource_names`) is managed.
- **Service Account keys.** A key is a downloadable credential generated
  once, with no readable value to diff against a declared spec — manage keys
  directly in Twingate (Settings > Service Accounts).
- **Security Policies.** Referenced nowhere yet — not a Veltrix config type.

### Design notes

- **Access is full-replacement.** `group_names` on every deploy REPLACES the
  resource's Group access with exactly that list (via `resourceCreate`/
  `resourceUpdate`'s `groupIds`), matching this app's Infrastructure-as-Code
  model: the canvas is the desired state, not a partial overlay. Leave it
  empty for no Group access.
- **Name resolution fails closed.** If a declared `remote_network_name` or
  `group_names` entry doesn't match a live Twingate object, `deploy` aborts
  (rather than silently creating the resource without the intended access, or
  guessing an id) — fix the name or create the missing object in Twingate,
  then re-deploy.
- **Business-level mutation failures.** Every Twingate mutation used by this
  app returns `{ ok: Boolean!, error: String, entity }` — a request can be
  transport-successful yet still fail with `ok: false` (e.g. a duplicate
  name). Every config type checks `ok`/`error` on every mutation, not just the
  GraphQL transport status.
- **Each config type is self-contained.** `_shared.ts`, GraphQL documents and
  small helpers (name-key normalization, `assertMutationOk`, …) are
  duplicated per config type rather than shared across them — consistent with
  how other Veltrix apps (e.g. Wiz) keep each configuration type
  independently maintainable. Only `lib/twingateApi.ts` (the GraphQL
  transport itself) is shared across all four.

## Coverage

The v0.3.0 pass enumerated Twingate's config-as-code write surface against
its official API reference (`twingate.com/docs/api*`) **and** the full
resource/data-source list of the Twingate-maintained Terraform provider
(`terraform-provider-twingate/docs/resources/*.md` and
`docs/data-sources/*.md`) — the provider's resource docs are effectively an
independently-verified list of everything the schema actually exposes as
writable, since Twingate maintains that provider itself.

**Managed** (this app):

| Object | Mutations | Config type |
| --- | --- | --- |
| Resource (`NetworkResource`) | `resourceCreate` / `Update` / `Delete` | `resources` |
| Remote Network | `remoteNetworkCreate` / `Update` / `Delete` | `remote-networks` |
| Group (`MANUAL` only) | `groupCreate` / `Update` / `Delete` | `groups` |
| Service Account (name only) | `serviceAccountCreate` / `Update` / `Delete` | `service-accounts` |
| Connector | `connectorCreate` / `Update` / `Delete` | `connectors` |
| DNS Filtering Profile | `dnsFilteringProfileCreate` / `Update` / `Delete` | `dns-filtering-profiles` |

**Verified read-only — EXCLUDED, cannot be managed as code:**

- **Security Policies.** The Terraform provider ships
  `docs/data-sources/security_policies.md` / `security_policy.md` with **no**
  corresponding file under `docs/resources/` — confirmed at the source level
  too: `twingate/internal/client/query/` has only `security-policies-read.go`
  / `security-policy-read.go`, no create/update/delete query file (every other
  managed object above has one). Twingate exposes Security Policies for
  *reference* (e.g. a Resource's `security_policy_id`) but not for mutation —
  they are administered only in the Twingate Admin Console.
- **`sync_to_s3`.** Same pattern: a data-source doc with no resource
  counterpart — an export/audit configuration surfaced read-only.

**Genuinely writable, deliberately EXCLUDED from this app (with reason):**

- **Connector tokens** (`connectorTokenGenerate`) and **Service Account keys**
  (`serviceAccountKeyCreate`/`Update`/`Delete`/`Revoke`) — one-time bearer
  credentials. Twingate never returns their value after generation, so there
  is no declarative "desired state" to diff against, and rotating one from a
  pipeline risks breaking a running Connector/workload with nothing to roll
  back to. Generate and rotate these directly in Twingate.
- **X.509 / SSH Certificate Authorities** (`x509CertificateAuthorityCreate`,
  `sshCertificateAuthorityCreate` — both **create + delete only, no update
  mutation exists** in the schema). Their `certificate` / `publicKey` fields
  are also write-only (never returned by a read), so — unlike every object
  above — this app could not even detect a content change if it modeled them.
  A future wave could still manage them Wiz-service-account style (create
  missing, never touch an existing one, matching the "create + delete only"
  API shape), but their main consumer (see Gateway, next) isn't manageable
  yet either, so it was not prioritized this wave.
- **Gateway** (`gatewayCreate`/`Update`/`Delete` — full CRUD exists). Excluded
  for a structural reason, not a policy one: the schema exposes only a
  single-object `gateway(id: ID!)` read — there is **no plural `gateways`
  list/connection query** (every other object here has one; confirmed by the
  absence of a `gateways-read.go` in the provider, unlike
  `remote-networks-read.go` / `connectors-read.go` / `groups-read.go` / etc.)
  and Gateway has **no `name` field**. This app's whole model depends on
  rediscovering live objects by name each run (for drift detection and to
  find an object created outside Veltrix); Terraform can manage Gateway only
  because Terraform owns a persistent state file to remember the id across
  applies. A future wave could adapt to this (Veltrix's own deployment
  history is retrievable via `ctx.platform.getLatestDeployment(...).rollbackData`
  and could serve as that id ledger, verified live via `gateway(id)` each
  run) — flagged as a real but unbuilt path, not attempted here to avoid
  shipping an unverified reconciliation strategy.
- **SSH Resource / Kubernetes Resource / Web App Resource** (specialized
  `Resource` kinds with their own `sshResourceCreate` /
  `kubernetesResourceCreate` / `webAppResourceCreate` mutations). SSH and
  Kubernetes Resources both *require* a `gateway_id` — since Gateway isn't
  manageable yet (above), these inherit the same limitation. Web App Resource
  additionally has no corresponding file in the Terraform provider's
  `docs/resources/` at all, so its exact input shape is unconfirmed.
- **Gateway Config** (`twingate_gateway_config` in the Terraform provider).
  **Not a Twingate API object at all** — verified it has no corresponding
  GraphQL mutation; it is a purely local Terraform construct that renders a
  YAML file from other resources' attributes. Not applicable to an app that
  talks to the GraphQL API directly.
- **`resourceAccessAdd` / `resourceAccessRemove`.** Alternate, incremental
  mutations for the same Resource↔Group/Service-Account relationship this app
  already manages via `resourceCreate`/`Update`'s full-replacement `groupIds`
  — not a distinct object, just a different mutation shape for data already
  covered.

**Identity/administration — EXCLUDED as a category:**

- **User** (`userCreate`/`Update`/`Delete` exist and are genuinely writable —
  `email`, `first_name`, `last_name`, `role`, `is_active`). Excluded on
  purpose: Twingate users are normally provisioned by an IdP/SSO (SAML/SCIM)
  — the User type's own `type` field (`MANUAL` vs `SYNCED`) mirrors Group's
  exact same split. Creating human accounts and sending email invites as a
  side effect of a config-as-code `deploy`, and — far more importantly —
  *deleting a person's account* as a side effect of `rollback`, is an outsized
  and inappropriate blast radius for this app's declarative model. Manage
  users via your IdP.
- **SYNCED / SYSTEM Groups** — externally (IdP-)controlled or Twingate-owned;
  see the `groups` config type, which already enforces this exclusion at
  reconciliation time (not just in docs).

**Finding: the surface is now genuinely near-exhausted.** Of the 15
first-class objects the Terraform provider documents under `docs/resources/`
(`connector`, `connector_tokens`, `dns_filtering_profile`, `gateway`,
`gateway_config`, `group`, `kubernetes_resource`, `remote_network`,
`resource`, `service_account`, `service_account_key`,
`ssh_certificate_authority`, `ssh_resource`, `user`, `x509_certificate_authority`),
6 are managed by this app, 2 are one-time credentials this app will never
manage, 1 (User) is excluded as an identity-provisioning concern, 1 (Gateway
Config) isn't an API object, and the remaining 5 (Gateway + its 2 CAs + its 2
dependent Resource kinds) form one connected feature cluster gated on
Gateway's list-query limitation above — a real, well-defined next step rather
than an open-ended one.

## Authentication

A single **API key**, sent as the `X-API-KEY` header (no token exchange, no
expiry). Generate one in the Twingate Admin Console under **Settings > API >
Generate Token**, then store it as a Veltrix connection:

- **API token** → the generated key
- **Username** → optional, a label only (Twingate's key has no paired account id)

## Component

Register a `twingate-network` component (or save it via the Connections page)
whose **hostname** is your Twingate network name — either the bare name
(`acme`) or the full host (`acme.twingate.com`); this app normalizes either
form. GraphQL requests go to `https://<network>.twingate.com/api/graphql/`.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for Twingate GraphQL API calls. |

## Rate limits

Twingate limits requests to 60 reads / 20 writes per minute by default and
returns HTTP 429 when exceeded. This app retries a 429 with a short backoff
(see `lib/twingateApi.ts`).

## Sources

- https://www.twingate.com/docs/api-overview — endpoint URL pattern, `X-API-KEY`
  auth, request/response shape, rate limits
- https://www.twingate.com/docs/api — `resourceCreate`/`resourceUpdate`/
  `resourceDelete`, `remoteNetworkCreate`/`Update`/`Delete`, `groupCreate`/
  `Update`/`Delete` and `serviceAccountCreate`/`Update`/`Delete` input +
  payload fields, and the `resources`/`remoteNetworks`/`groups`/
  `serviceAccounts` query shapes
- https://github.com/Twingate/terraform-provider-twingate — Twingate-maintained,
  tested Go GraphQL client; used to confirm the `... on NetworkResource` inline
  fragment mechanics, the `ProtocolPolicy` enum values (`ALLOW_ALL` /
  `RESTRICTED` / `DENY_ALL`), the `Location` enum (`AWS`/`AZURE`/
  `GOOGLE_CLOUD`/`ON_PREMISE`/`OTHER`), the `RemoteNetworkType` enum
  (`REGULAR`/`EXIT`), the Group `type` constants (`MANUAL`/`SYNCED`/`SYSTEM`),
  the `connectorCreate`/`Update`/`Delete` and `dnsFilteringProfileCreate`/
  `Update`/`Delete` variable sets (including every DNS category flag name),
  the `FallbackMethod` enum (`AUTO`/`STRICT`), and — for the Coverage section
  — its full `docs/resources/*.md` + `docs/data-sources/*.md` listing and the
  `internal/client/query/` file inventory (used to confirm which objects have
  create/update/delete query files at all, and which have only a `-read.go`)

## Development

```
cd apps/twingate
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs twingate          # run handler tests
node ../../scripts/validate-app.mjs apps/twingate  # validate against the app contract
```
