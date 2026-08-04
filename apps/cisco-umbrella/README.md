# Cisco Umbrella

Manage **Cisco Umbrella** (Secure Internet Gateway / DNS-layer security)
configuration as code through the Umbrella API, with validation, drift
detection and rollback handled by the Veltrix Security-as-Code pipeline.
Configuration types are grouped by Umbrella API family — **Deployments** and
**Policies** — in the sidebar, mirroring Cisco's own API section naming.

## What it manages

| Configuration type | Group | Umbrella API surface | Notes |
|---|---|---|---|
| **Destination Lists** | Policies | `/policies/v2/destinationlists` | Allow / block lists of domains, URLs and IPs. |
| **Networks** (`internal-networks`) | Deployments | `/deployments/v2/networks` | Registered networks (egress/public IP ranges). |
| **Internal Domains** | Deployments | `/deployments/v2/internaldomains` | Domains that bypass the Umbrella resolvers to the local resolver. |
| **Sites** | Deployments | `/deployments/v2/sites` | Location groupings for Virtual Appliances. |
| **Internal Network Subnets** | Deployments | `/deployments/v2/internalnetworks` | RFC1918/non-RFC1918 subnets tied to a Site, Network or Tunnel. |
| **Network Tunnels** | Deployments | `/deployments/v2/tunnels` | IPsec tunnels for onramping traffic to Umbrella's SIG. |
| **Internal Network Policy Assignments** | Policies | `/deployments/v2/policies/{id}/identities/{id}` | Assign an Internal Network Subnet identity to a DNS/Web policy. |

Umbrella destination lists are addressed by an opaque numeric **id** (there is no
lookup-by-name), so the app matches a declared list to a live one by **name** and
stores the id from the deploy for rename-safety on the next deploy. A list's
`access` (allow/block) and global scope are set at create time and are
**immutable** afterward; the list's destinations are synced to exactly what is
declared. Reconcile only deletes lists this app created but no longer declares.
Every Deployments-API resource (Networks, Internal Domains, Sites, Internal
Network Subnets, Network Tunnels) follows the same opaque-id + match-by-name +
rename-safety + reconcile-only-what-this-app-created shape.

## Authentication

The Umbrella API uses the **OAuth2 client-credentials** flow. Create an API key
in the Umbrella dashboard under **Admin → API Keys** with the **Destination
Lists** scope (read/write), and store the credential as:

- **Username** → the **API Key**
- **API token** → the **API Secret**

On every run the app exchanges the key + secret for a short-lived bearer token
(`POST https://api.umbrella.com/auth/v2/token`, HTTP Basic + `grant_type=client_credentials`,
~1 hour lifetime) and calls the API with `Authorization: Bearer <token>`. The base
URL is fixed to `https://api.umbrella.com` (no per-tenant host).

## Configuration type: Destination Lists

Each canvas item is one destination list:

- **Name** — the logical identity (unique in the canvas), ≤ 50 chars.
- **Access** — `block` or `allow` (immutable after create).
- **Global list** — whether it applies to all policies (immutable after create).
- **Destinations** — one per line: a domain (`example.com`), a URL
  (`example.com/path`, block lists only) or an IPv4 / CIDR (`10.0.0.0/24`, allow
  lists only). Up to 500 per list; synced to exactly these values on deploy.

## Configuration type: Internal Network Subnets

Each canvas item is one Umbrella "Internal Network" — an RFC1918 (or
non-RFC1918) subnet tied to exactly **one** of a Site, a (registered) Network,
or a Tunnel, which scopes which DNS/Web policy applies to traffic from that
subnet:

- **Name** — the logical identity, ≤ 50 chars.
- **IP address** / **Prefix length** — the subnet's base IPv4 address and
  CIDR prefix (9–32, per Umbrella's documented range).
- **Associate with** — `site`, `network` or `tunnel` — **Site** scopes for DNS
  policies, **Network** scopes for Web policies through proxy chaining,
  **Tunnel** scopes for Web policies through an IPsec tunnel.
- **Site / Network / Tunnel name** — the name of the associated resource,
  resolved to Umbrella's opaque id at deploy time (it must already exist).

> **Naming note:** this is a *different* Umbrella resource from this app's
> **Networks** config type (`internal-networks`, `/deployments/v2/networks` —
> egress IPs). It is registered as `internal-network-subnets` to avoid
> colliding with that pre-existing (and, in hindsight, confusingly-named)
> config type id.

## Configuration type: Network Tunnels

Each canvas item is one Umbrella IPsec tunnel used to onramp traffic to
Umbrella's Secure Internet Gateway:

- **Name** — the logical identity, ≤ 50 chars.
- **Device type** — free text (Cisco has not published a closed enum in the
  public API reference); `"other"` is the only value confirmed to work in
  every available sample.
- **Site (optional)** — an existing Site's name, resolved to a `siteOriginId`.
- **PSK secret** — write-only; Umbrella never returns it, so it cannot be
  diffed, logged, or captured for rollback.
- **ID prefix** — optional identifier prefix for the tunnel's PSK
  authentication (the local IKE ID).

**No update endpoint was found in any reference** — Cisco's official external
Postman collection, the community `josgabfer/UmbrellaAPI` project, and Cisco's
own Refit-based `.NET` client all expose only create (`POST`), list (`GET`) and
delete (`DELETE`) for a tunnel. Deploy therefore treats an existing tunnel as
**immutable**: it is left untouched (a note is emitted if its device type looks
different from what's declared); remove the canvas item and re-declare it to
recreate the tunnel with new settings. Rollback only ever deletes tunnels this
app created; a pre-existing tunnel this app never created is left in place.

## Configuration type: Internal Network Policy Assignments

Umbrella's DNS/Web **policies themselves are read-only** through the public
API (`GET /deployments/v2/policies?type=dns|web` only — no create, update or
delete of the policy object or its ruleset exists). The one **confirmed write
capability** on a policy is *membership*: assigning or unassigning an identity
to/from it, via `PUT`/`DELETE /deployments/v2/policies/{policyId}/identities/{originId}`
(no request body). This config type wraps that capability, scoped to the one
identity type this app also manages end-to-end — **Internal Network Subnets**:

- **Internal network subnet name** — the Name of an Internal Network Subnet
  declared by this app's Internal Network Subnets config type (or already
  existing in Umbrella), resolved to its `originId` at deploy time.
- **Policy type** — `dns` or `web`.
- **Policy name** — the Name of an existing DNS or Web policy **created in the
  Umbrella dashboard** (policies are not created through this app — they can't
  be, through any public API). Resolved to its `policyId` at deploy time.

Reconcile and rollback only ever touch memberships this app added — an
assignment that already existed before this app's first deploy (e.g. one made
in the dashboard) is left in place, never removed. Drift detection verifies
each declared assignment against
`GET /deployments/v2/internalnetworks/{originId}/policies` — the one identity
type with a confirmed read-back endpoint, letting this config type prove an
assignment is actually in effect rather than only ever asserting it blindly.

> Extending this membership write to other identity types (Networks, Roaming
> Computers, ...) is deferred until their own policies-listing endpoint is
> independently confirmed — see [Coverage](#coverage) below.

## Component

Register a `cisco-umbrella` component and attach the credential. Because the
API base is fixed, the component's hostname is only a human label and is
never used as a network address.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for Umbrella API calls. |

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs cisco-umbrella

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/cisco-umbrella
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.

## Coverage (v0.3.0)

Coverage was audited by cross-referencing Cisco's official external Postman
collection (`CiscoDevNet/cloud-security`, `Umbrella/PostmanExamples/`), the
community `josgabfer/UmbrellaAPI` project (working scripts calling
`api.umbrella.com` directly), Cisco's own Refit-based `.NET` client
(`panoramicdata/Cisco.Api`, with XML-documented request/response models), and
Microsoft's official Azure Sentinel Cisco Umbrella playbooks — not assumed
from prior knowledge.

### Managed declarative configuration

| Configuration type | Umbrella API operations |
| --- | --- |
| Destination Lists | list/create/get/update/delete `/policies/v2/destinationlists` + destinations sync |
| Networks | list/create/update/delete `/deployments/v2/networks` |
| Internal Domains | list/create/delete `/deployments/v2/internaldomains` |
| Sites | list/create/update/delete `/deployments/v2/sites` (default site never deleted) |
| Internal Network Subnets | list/create/update/delete `/deployments/v2/internalnetworks`, association resolved by name |
| Network Tunnels | list/create/delete `/deployments/v2/tunnels` (no update endpoint found) |
| Internal Network Policy Assignments | `PUT`/`DELETE /deployments/v2/policies/{id}/identities/{id}` (membership only) |

### Intentionally excluded

- **DNS/Web Policies** (the policy object/ruleset itself — content filtering,
  security settings, block pages, rule ordering): confirmed **read-only**
  (`GET /deployments/v2/policies?type=dns|web` only). No create/update/delete
  was found anywhere across every reference checked. Policy composition
  remains dashboard-only; only identity *membership* is writable (see Internal
  Network Policy Assignments above).
- **Virtual Appliances**, **Roaming Computers**, **Network Devices**: all
  confirmed read-only (list/get only, no create/update/delete found in any
  reference). Virtual Appliances are provisioned by deploying the OVA/AMI and
  registering it with a dashboard-generated activation key, not by declaring
  one from scratch; Roaming Computers and Network Devices are per-device/
  per-appliance inventory (Umbrella-wide identity records for existing
  hardware/software), not declarative security configuration.
- **Device Tagging** (`/deployments/v2/tags`): a tag can be created and
  assigned/removed on devices, but **no delete-tag endpoint** was found in any
  reference — this app's create/track/delete reconcile lifecycle cannot be
  safely implemented without one, and tag-to-device assignment is device
  inventory management, not policy configuration.
- **Admin** (Roles, Users, API Keys — `/admin/v2/*`): security-sensitive
  control-plane bootstrap, excluded on the same precedent as `cisco-meraki`'s
  organization-administrator exclusion. Creating API keys or admin users from
  a canvas is a secrets-management anti-pattern, not security configuration.
- **Selective Decryption Lists**: investigated and **not found** as a
  documented endpoint anywhere in classic Umbrella's public API
  (`api.umbrella.com`). A `do_not_decrypt_lists` resource exists only under
  the separate **Cisco Secure Access** product (`api.sse.cisco.com` — a
  different base URL and, per Cisco's own SDK, a different product), which is
  out of this app's scope.
- **Reports, Investigate, Activity, App Discovery, API Usage** (`/reports/v2/*`,
  `/investigate/v2/*`): entirely read-only telemetry/threat-intelligence APIs,
  not configuration.

Primary references: Cisco's [Umbrella API documentation](https://developer.cisco.com/docs/cloud-security/)
and each endpoint's shape as implemented in `lib/umbrellaApi.ts` / `lib/deployments.ts`.
