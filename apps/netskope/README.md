# Netskope

Manage **Netskope** configuration as code through the Netskope REST API v2, with
validation, drift detection and rollback handled by the Veltrix Security-as-Code
pipeline.

## What it manages

| Configuration type | Netskope surface | Notes |
|---|---|---|
| **URL Lists** | `/api/v2/policy/urllist` | Allow/block lists — exact URLs/IPs or regex patterns. Pending → deploy model (see below). |
| **Custom Categories** | `/api/v2/profiles/customcategories` | Groups URL lists, destination profiles and predefined categories under one name. PATCH auto-deploys. |
| **Service Objects** | `/api/v2/profiles/serviceobjects` | Named port/protocol groups (tcp/udp/tcp+udp, icmp). Netskope's own `PREDEFINED` objects are preserved. |
| **Device Classification Tags** | `/api/v2/deviceclassification/tags` | Device posture tags referenced by NPA rules. |
| **RBAC Labels** | `/api/v2/rbac/labels` | Label Based Access Control labels (name + color). |
| **NPA Publishers** | `/api/v2/infrastructure/publishers` | Publisher name + local broker connect. |
| **Private Apps** | `/api/v2/steering/apps/private` | NPA private apps — host, protocols, publishers. |
| **NPA Policy Groups** | `/api/v2/policy/npa/policygroups` | Named NPA rule-group containers; built-in groups preserved. |
| **NPA Policy Rules** | `/api/v2/policy/npa/rules` | Private-app policy rules (action, apps, users, network scoping). |
| **DNS Security Profiles** | `/api/v2/profiles/dns` | Logging plus domain/tunnel/custom config as validated JSON. |
| **Destination Profiles** | `/api/v2/profiles/destinations` | Network-location profiles with RBAC label assignment. |
| **GRE Tunnels** | `/api/v2/steering/gre/tunnels` | Branch connectivity — source IP, POPs, bandwidth. |
| **IPSec Tunnels** | `/api/v2/steering/ipsec/tunnels` | Branch connectivity with a write-only pre-shared key. |
| **Publisher Upgrade Profiles** | `/api/v2/infrastructure/publisherupgradeprofiles` | Release channel, docker tag, CRON upgrade schedule. |
| **NPA Local Brokers** | `/api/v2/infrastructure/lbrokers` | Local broker records — access mode, IP overrides, RBAC labels. |
| **NPA Local Broker Config** | `/api/v2/infrastructure/lbrokers/brokerconfig` | Tenant-wide broker hostname setting. Singleton, no delete operation. |
| **NPA Publisher Alerts Configuration** | `/api/v2/infrastructure/publishers/alertsconfiguration` | Tenant-wide publisher alert notification policy. Singleton, camelCase body, no delete operation. |
| **AI Gateway Providers** | `/api/v2/aig/aiproviders` | Custom AI providers — endpoint + schema, write-only certificate. |
| **AI Gateway MCP Servers** | `/api/v2/aig/mcpservers` | Custom MCP servers — endpoint, optional tools/resources/prompts filters. |
| **AI Gateway Rate Limits** | `/api/v2/aig/ratelimits` | Rate-limit rules — criteria/threshold as validated JSON. |
| **AI Gateway Token Groups** | `/api/v2/aig/tokengroups` | API token group containers (not the per-token secrets). |
| **AI Gateway Appliances** | `/api/v2/aig/appliances` | Appliance host/ports, AI provider & MCP server associations, SKU add-ons. One-time enrollment token never read. |

Every type is name- (or site-) keyed with the live id stored after deploy for
rename-safety, and reconcile only ever deletes objects this app created and no
longer declares. See each configuration type's `canvas.yaml` for its exact
field set and helper text, and **Coverage** below for what is deliberately
excluded and why.

> **URL lists — pending → deploy:** create/update/delete only *stage* a
> change. The app then issues a single `POST /api/v2/policy/urllist/deploy`
> to apply all pending url-list changes on the tenant — so avoid editing url
> lists elsewhere at the same time. Every other configuration type auto-applies
> (PATCH/PUT/POST take effect immediately) and needs no separate deploy call.

## Authentication

Netskope authenticates with a **REST API v2 token** sent as the
`Netskope-Api-Token` header. In the admin console, go to **Settings > Tools >
REST API v2**, create a token, and grant it read/write privilege on every
endpoint listed above that you intend to manage. Store the credential as:

- **Password** → the REST API v2 token

Set the app's **Tenant** setting to your tenant host (e.g. `acme.goskope.com`);
the API base is `https://{tenant}/api/v2`.

## Coverage

What this app manages, what it deliberately does not, and why. Built
research-first against Netskope's official open-source Terraform provider
(`netskopeoss/terraform-provider-netskope`), which Netskope generates directly
from its internal OpenAPI spec via Speakeasy — cross-checked against the
provider's published v0.4.8 schema (registry + git tag, not just its README),
its `docs/api-audit/*.md` real-tenant-traffic audits, and its
`internal/sdk/*.go` HTTP operation source.

### Managed (22 configuration types)

URL Lists, Custom Categories, Service Objects, Device Classification Tags,
RBAC Labels, NPA Publishers, Private Apps, NPA Policy Groups, NPA Policy
Rules, DNS Security Profiles, Destination Profiles, GRE Tunnels, IPSec
Tunnels, Publisher Upgrade Profiles, NPA Local Brokers, NPA Local Broker
Config, NPA Publisher Alerts Configuration, AI Gateway Providers, AI Gateway
MCP Servers, AI Gateway Rate Limits, AI Gateway Token Groups, AI Gateway
Appliances — see the table above for each one's endpoint and identity key.

### Excluded, with reasons

| Surface | Why excluded |
| --- | --- |
| **Real-time Protection policies** (the policy engine outside NPA — CASB/inline web policies) | No REST API v2 write surface for this policy family was found in Netskope's own OpenAPI-derived Terraform provider, its api-audit traces, or its public docs. Custom Categories (this app manages them) are a genuine, confirmed input to these policies; the policies themselves remain UI/console-configured. |
| **API-Data-Protection policies** | Same as above — not present anywhere in the verified API surface available to this app. |
| **DLP profiles / rules** | Same as above. Netskope's DLP configuration has historically been console-only; no `/api/v2/policy/dlp*` (or equivalent) write endpoint was found in any of the three sources this app cross-checked. |
| **RBAC admin Roles** (`netskope_rbac_role` in the upstream Terraform provider — distinct from the RBAC **Labels** this app already manages) | The provider's own `docs/api-audit/rbac_roles.md` documents this against a **separate backend service** — `ms-rbac` at `bespin.goskope.com` — not the tenant's `{tenant}.goskope.com/api/v2` host this app's client is built around. It is also not yet in the provider's published v0.4.8 schema (confirmed absent from both the registry's rendered docs and the `v0.4.8` git tag — only present on the provider's unreleased `main` branch). A distinct host and likely a distinct auth model (OAuth2 client-credentials, not the `Netskope-Api-Token` header) make this a separate integration, not an extension of the existing client — deferred rather than half-built. |
| **`platform_oauth2_token` (OAuth2 client-credentials exchange)** | An authentication action, not stored configuration — refreshes a bearer token on every use rather than describing a resource. Also unreleased (same "unreleased `main`-only" caveat as RBAC Roles above). |
| **NPA Publisher / Local Broker registration tokens** (`npa_publisher_token`, `npa_local_broker_token`) | Bootstrap secrets minted by Netskope to enroll a physical/virtual publisher or broker. Each request likely **invalidates the previous token** — the opposite of the idempotent PUT/PATCH semantics every other type in this app relies on — and the value itself is exactly the kind of secret material this app never stores or diffs. |
| **AI Gateway appliance enrollment tokens** (`aig_appliance_enrollment_token`) | Same reasoning as the NPA tokens above — the appliance **record** is managed (see AI Gateway Appliances); its one-time JWT enrollment token, returned only inline on create, is not. |
| **NPA Private App Public Host** (`npa_private_app_public_host`) | Confirmed, via the upstream provider's own resource source, to have **no GET-by-id, no DELETE, and no import** — only a single (oddly-named) create call. Not round-trippable: this app cannot detect drift or reliably roll it back, so it does not manage it. |
| **NPA Rules Order** (`npa_rules_order`) | The upstream provider's own docs state it "does not support import" (no reliable read-back) and its ordering is entangled with the NPA Policy Rules this app already manages via a separate `rule_order` field the provider recommends ignoring — managing both risks the two configuration types fighting each other over the same live state. |
| **NPA Publisher bulk actions** (`npa_publishers_bulk_profile_updates`, `npa_publishers_bulk_upgrade_request`) | One-shot triggers (assign an upgrade profile to N publishers; force an upgrade now), not declarative state — re-running them on every deploy would re-trigger the action rather than converge on a desired configuration. |
| **AI Gateway per-token secrets** (`aig_token`) | The token **group** container is managed (AI Gateway Token Groups); the individual token's value is sensitive and returned only on create — consistent with how every other secret in this app is handled. |

### Secret / write-only handling, explicit

- **Never read back, diffed, or stored**: `ipsec-tunnels.psk`,
  `aig-ai-providers.certificate`, `aig-mcp-servers.certificate` — sent on
  every deploy, never returned by the API, never compared for drift.
- **Never read at all**: the AI Gateway Appliance create response's
  `enrollment_token` / `enrollment_token_expire_time` fields — this app's
  `LiveAigAppliance` type does not even declare them, so the deploy handler
  has no way to reference, log or persist them.

## Development

```bash
# typecheck (server/handlers/lib/config-types — client is bundled separately)
npm run typecheck

# run tests (from the repo root)
node scripts/test-apps.mjs netskope

# validate the app (manifest + layout + dry client bundle)
node scripts/validate-app.mjs apps/netskope
```

See the repo's [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide.
