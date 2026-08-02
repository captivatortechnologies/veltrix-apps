# Twingate (Veltrix app)

Manage [Twingate](https://www.twingate.com) (ZTNA / Zero Trust Network Access)
configuration as code through the **Twingate GraphQL API**, driven by the
Veltrix Security-as-Code pipeline (validate → deploy → health check → drift
detect → rollback).

## What it manages

| Configuration type | Twingate object | GraphQL operations |
| --- | --- | --- |
| **Resources** (`resources`) | Resources (private apps/hosts/subnets, protocols and Group access) | `resources` (list), `resource` (read), `resourceCreate`, `resourceUpdate`, `resourceDelete` |

Resources reconcile by **name** and target a `twingate-network` component.

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

### Scope (v0.1.0)

Twingate has specialized resource kinds (SSH, Kubernetes, Web App) with their
own `sshResourceCreate` / `kubernetesResourceCreate` / `webAppResourceCreate`
mutations, and additional fields on the base mutation this app does not yet
manage: `securityPolicyId`, `tags`, `accessPolicy`/`approvalMode`/
`approverGroupIds` (Access Policies aren't yet a Veltrix config type), and
`serviceAccountIds` access (Service Accounts aren't yet a Veltrix config
type). These are deliberately **out of scope** for this version rather than
guessed at — see the citations in `config-types/resources/_shared.ts`. Remote
Networks and Groups are referenced by name but are not themselves managed as
code here; create them directly in Twingate first.

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
- **Business-level mutation failures.** Twingate's resource mutations return
  `{ ok: Boolean!, error: String, entity }` — a request can be
  transport-successful yet still fail with `ok: false` (e.g. a duplicate
  resource name). This app checks `ok`/`error` on every mutation, not just the
  GraphQL transport status.

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
  `resourceDelete` input + payload fields, the `Resource` type's field list,
  the `resources`/`remoteNetworks`/`groups` query shapes
- https://github.com/Twingate/terraform-provider-twingate — Twingate-maintained,
  tested Go GraphQL client; used to confirm the `... on NetworkResource` inline
  fragment mechanics and the `ProtocolPolicy` enum values (`ALLOW_ALL` /
  `RESTRICTED` / `DENY_ALL`)

## Development

```
cd apps/twingate
node node_modules/typescript/bin/tsc --noEmit      # typecheck
node ../../scripts/test-apps.mjs twingate          # run handler tests
node ../../scripts/validate-app.mjs apps/twingate  # validate against the app contract
```
