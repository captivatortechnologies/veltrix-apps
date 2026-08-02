# Cisco Meraki (Veltrix app)

Manage [Cisco Meraki](https://meraki.cisco.com) Dashboard network security
configuration as code through the **Meraki Dashboard API v1**, driven by the
Veltrix Security-as-Code pipeline (validate → deploy → health check → drift
detect → rollback).

## What it manages

| Configuration type | Meraki object | API operations |
| --- | --- | --- |
| **L3 Firewall Rules** (`l3-firewall-rules`) | MX L3 (outbound) firewall ruleset, per network | `GET` / `PUT /networks/{networkId}/appliance/firewall/l3FirewallRules` |

### L3 Firewall Rules — an ordered singleton per network

Meraki stores a network's whole MX L3 (outbound) firewall ruleset as **one
ordered list**; there is no API to create or delete an individual rule, only a
**whole-list replace**. This config type therefore models **one canvas item per
Meraki network**, identified by its `network_id` — the same shape used for
Cribl's Routes config type. The ordered `rules` array is authored as JSON;
**order is significant** (rules are evaluated top to bottom) and drift
detection compares the list **order-sensitively**.

Meraki appends an implicit final **"Default rule"** (`allow any/any`) after
every custom rule. It is never part of the managed list — the API excludes it
on read and rejects it if you try to declare it — and it cannot be edited or
removed through this endpoint.

Deploy always reads the network's current ruleset first (captured as
`rollbackData`) before overwriting it, so rollback can restore the exact prior
ordered list.

#### `syslog_default_rule` — a write-only flag

The canvas also exposes **"Log the Default Rule"** (`syslog_default_rule`),
which maps to the API's `syslogDefaultRule` boolean. Meraki accepts this field
on `PUT` but **never returns its current value** on `GET` or `PUT` — the
response is always just `{ "rules": [...] }`. As a direct consequence:

- **Drift detection never compares it** — there is nothing live to diff against.
- **Rollback never restores it** — there is no prior value on record. Rollback
  restores the ordered `rules` list only and omits `syslogDefaultRule` from its
  restore request entirely, rather than guessing a value.
- Every successful **deploy** re-applies whatever value is currently declared
  on the canvas.

## Authentication

A **Meraki Dashboard API key**. In the dashboard, enable API access
(**Organization → Settings → Dashboard API access**), then generate a key from
your admin profile page (**Generate new API key** — shown once). Store it as a
Veltrix credential:

- **API token** → the Meraki Dashboard API key

The app sends it as `Authorization: Bearer <key>` (the modern v1 scheme; the
legacy `X-Cisco-Meraki-API-Key` header is not used) to the **fixed** base
`https://api.meraki.com/api/v1` — there is no per-organization API host.

## Component

Register a `meraki-organization` component and attach the credential. Because
the API base is fixed, the component's hostname is only a human label (e.g.
your organization's name) and is never used as a network address.

Each **L3 Firewall Rules** canvas item independently targets one Meraki
**network** by its `network_id` (e.g. `L_646829496481099008` /
`N_646829496481099008`) — find it in the dashboard URL for that network, or via
`GET /organizations/{organizationId}/networks`.

## Rate limiting

The Meraki Dashboard API enforces **10 requests/second per organization**
(burst +10 in the first second, up to 30 in a 2-second window) and **100
requests/second per source IP**. A `429` response includes a `Retry-After`
header (seconds); the client honors it with a bounded retry before failing.

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `request_timeout_seconds` | `30` | Per-request timeout for Meraki Dashboard API calls. |

## Known limitations (v0.1.0)

- Only **L3 (outbound) firewall rules** are managed. Meraki's L7 firewall
  rules, one-to-one/one-to-many NAT, port forwarding, site-to-site VPN,
  wireless SSIDs, switch ports, etc. are not yet covered — planned as
  additional configuration types in a future release.
- No live pre-check that `network_id` refers to an MX-capable (appliance)
  network at `validate` time — an invalid or non-appliance network surfaces a
  clear error from Meraki at `deploy` time instead.
- No drift-attribution ("who changed it + when"). Meraki's
  `getOrganizationConfigurationChanges` audit log could support this (as the
  Wiz app does via its own audit log) — deferred to a follow-up release.

## Development

```
cd apps/cisco-meraki
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs cisco-meraki          # run handler tests
node ../../scripts/validate-app.mjs apps/cisco-meraki  # validate against the app contract
```
