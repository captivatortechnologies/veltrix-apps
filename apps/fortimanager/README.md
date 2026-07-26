# FortiManager

Manage **Fortinet FortiManager** configuration as code through the FortiManager
JSON-RPC API, with validation, drift detection and rollback handled by the
Veltrix Security-as-Code pipeline.

## What it manages

| Configuration type | FortiManager surface | Notes |
|---|---|---|
| **Firewall Addresses** | `/pm/config/adom/<adom>/obj/firewall/address` | Firewall address objects — ipmask / iprange / fqdn / geography. |

Addresses are matched by their **name** (the FortiManager mkey / object identity)
and upserted with the `set` verb (create-or-replace). Reconcile only deletes
addresses this app created but no longer declares. When the ADOM is in
**workspace mode**, deploys and rollbacks run inside a `lock` → change → `commit`
→ `unlock` transaction.

## Authentication

FortiManager authenticates with an **admin user** over JSON-RPC. Store the
credential as:

- **Username** → the FortiManager admin username
- **Password** → that admin's password

The app logs in via `exec sys/login/user` and reuses the returned session token
(re-logging in automatically if it expires). Set the FortiManager **Host** and
target **ADOM** (default `root`) in the app's settings; enable **Workspace mode**
if the ADOM uses workspace/workflow mode.

> **TLS note:** this app uses the standard TLS stack, so the FortiManager must
> present a certificate the host trusts (a valid CA chain or FortiManager Cloud).

## Configuration type: Firewall Addresses

Each canvas item is one address:

- **Name** — the object identity (mkey), unique, ≤ 79 chars.
- **Type** — `ipmask`, `iprange`, `fqdn`, or `geography`.
- Type-specific value — **Subnet (CIDR)** for `ipmask` (converted to the
  `["ip","mask"]` form FortiManager expects), **Start/End IP** for `iprange`,
  **FQDN** for `fqdn`, **Country (ISO code)** for `geography`.
- **Comment** — optional.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs fortimanager

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/fortimanager
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
