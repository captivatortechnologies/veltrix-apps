# @veltrixsecops/app-sdk — OpenTofu (generic BYOI provisioning)

Tool-agnostic OpenTofu modules that every BYOI app composes to provision a fully
Veltrix-hosted environment. **There is no per-tool HCL** — an app declares its
shape as data (an `InfraSpec`) and the SDK renders it into these modules' tfvars.
Splunk Enterprise, Security Onion, or any other tool reuse the same modules.

## The three layers

```
sdk/opentofu/modules/<cloud>/     ← generic HCL (this dir). Nothing tool-specific.
sdk/src/opentofu/                 ← InfraSpec types + renderInfraVars() + validateInfraSpec()
apps/<app>/infra/spec.ts          ← the app's InfraSpec (its ports/LB/DNS/roles as DATA)
apps/<app>/infra/bringup/         ← the app's config management + readiness gate
```

The platform's render+apply **worker** (in the Veltrix platform repo) builds the
base tfvars from the deploy request, merges `renderInfraVars(spec)` on top,
`tofu apply`s the pinned module, then runs the app's `spec.bringup` entrypoint.

## What the module does (and what the app supplies)

| Concern | Module (generic) | App (via InfraSpec) |
|---|---|---|
| Compute nodes | one instance per non-foundation plan item | roles are just plan `kind`s |
| Security groups | SG-to-SG, one rule per `(port, source)` | `securityRules[]` |
| Front door | ALB + WAF + optional Cognito MFA + target group | `loadBalancer` (port, health path, target kinds) |
| DNS | public ALB record + private zone + per-node FQDNs | `dnsPrefixes` (kind → label) |
| Object storage | private S3 bucket | `storage[]` |
| TLS | ACM public wildcard (ALB); Private-CA per node (fabric) | — |
| Tags | every resource merges the canonical Veltrix tag set | — |

Compute detection is **foundation-exclusion**: any plan item whose `kind` is not
in `foundation_kinds` (network/storage/secrets/tls/load-balancer/dns/license-file/
hec) is a compute node — so a new tool's roles are compute automatically.

## Authoring an app's infra (example)

```ts
// apps/<app>/infra/spec.ts
import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 443, sources: ['alb'], description: 'Web UI' },
    { port: 8089, sources: ['self', 'admin'] },
  ],
  loadBalancer: { targetPort: 443, healthCheckPath: '/healthz', targetKinds: ['web'] },
  dnsPrefixes: { web: 'web', sensor: 'sensor', manager: 'mgr' },
  bringup: './bringup/run.mjs',
};
```

Validate it in a test with `validateInfraSpec(spec)` (returns `[]` when valid).

## Deployment modes — Veltrix-hosted vs BYOC

The same modules deploy into Veltrix's account *or* the customer's own cloud
account (Bring Your Own Cloud). This is controlled by two **worker-set**
variables — they are NOT part of the app's `InfraSpec` (which describes only the
tool), so one app spec serves both:

- **`network_mode`**
  - `shared` — Veltrix-hosted: data-source the shared VPC + the IPAM-allocated
    per-stack subnet.
  - `dedicated` — BYOC: **create** a fresh VPC/VNet/network + multi-AZ
    public/private subnets + gateway + NAT in the customer's account.
  - `existing` — BYOC: data-source a customer-designated network + create
    subnets in it.
- **`dns_mode`** (private intra-cluster DNS is always created in the deploy
  account's network regardless)
  - `managed` — module creates the public record + cert in-account (Veltrix zone
    for hosted, customer zone for BYOC customer-owned).
  - `delegated` — BYOC cross-account: the **worker** writes the public record +
    cert-validation into Veltrix's zone; the module takes a pre-validated
    `certificate_arn` and creates no public record/cert.
  - `private-only` — no public DNS; reached via the customer's network.

**Credentials/trust** are worker-level (the customer registers a least-privilege
role/SP/SA/token per cloud via Connections; the worker configures the provider
with it) — the module body is credential-agnostic.

## Contract notes / invariants

- **`plan_key` is the status-back key.** Every compute node and foundation tier
  maps `plan_key → cloud ref` via `output "resource_refs"`; keep it 1:1.
- **`node_fqdns` output** (`plan_key → function FQDN`) is what an app's bring-up
  inventory consumes.
- A `securityRules` entry using source `"alb"` requires a `loadBalancer`
  (enforced by `validateInfraSpec`).
- `alb_auth` (Cognito MFA) is off by default; when enabled all three
  `userPool*` fields are required.
- The module is **pinned + shipped in the package** (`files: ["opentofu"]`);
  the worker resolves it by path from the installed SDK.

## Status

All four clouds implement the identical spec-derived variable + output contract
and both deployment modes (`network_mode`, `dns_mode`). None is `tofu validate`-
gated yet — no OpenTofu binary in this environment, so they were built by close
translation of the AWS reference + manual review; **run `tofu validate` per
module in CI before first apply.**

| Cloud | Front door / WAF | SG-to-SG | Private DNS | Notable gaps (documented, no-op) |
|---|---|---|---|---|
| **aws** (reference) | ALB + WAFv2 + Cognito MFA | SG self-ref | Route53 private zone | — |
| **azure** | App Gateway + WAF_v2 | NSG + ASG | Private DNS zone | MFA (→ AAD App Proxy); TLS needs a KV cert + identity (no in-module ACM); `web_ingress_cidr` not wired |
| **gcp** | Global HTTPS LB + Cloud Armor | network tag + firewall | Cloud DNS private zone | MFA (→ IAP); no HTTP→HTTPS redirect; single-zone compute |
| **hetzner** | hcloud LB (no WAF) | firewall (CIDR) | **none in-provider** — FQDNs emitted for the bring-up / `hetznerdns` | no WAF; no managed DNS; object store → block volume; secrets → platform vault; no MFA |

Tags map to **labels** (sanitized) on GCP and Hetzner; Azure and AWS use tags
directly. Provider-specific vars (image, sizing, zone, public-zone refs) differ
per cloud by name; the **spec-derived** vars are identical everywhere.
