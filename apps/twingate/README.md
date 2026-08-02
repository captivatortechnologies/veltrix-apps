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
  (`REGULAR`/`EXIT`) and the Group `type` constants (`MANUAL`/`SYNCED`/`SYSTEM`)

## Development

```
cd apps/twingate
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs twingate          # run handler tests
node ../../scripts/validate-app.mjs apps/twingate  # validate against the app contract
```
