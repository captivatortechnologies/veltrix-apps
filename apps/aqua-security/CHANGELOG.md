# Changelog

All notable changes to the Aqua Security app are documented here.

## 0.1.0 — 2026-08-05

Initial release — nine config types spanning image/host/function/Kubernetes
assurance policies, container/host runtime policies, firewall policies,
application scopes and Enforcer Group protection configuration, over the
Aqua CSP/Enterprise Console REST API. Endpoints were confirmed against the
official `terraform-provider-aquasec` Go client (`client/*.go`) — the exact
source files are recorded in `lib/aquasec.ts`'s module doc and in each config
type's `deploy.ts`/`_shared.ts` header comment, and summarized in the
README's Coverage section.

- **Image / Host / Function / Kubernetes Assurance Policies** — one shared
  endpoint family (`/api/v2/assurance_policy/<type>`), a curated ~30-field
  subset covering identity/scope, enforcement, CVE/CVSS gates,
  malware/sensitive-data, package/license allow-denylists, CIS benchmarks,
  required/forbidden labels and an Aqua scope expression.
- **Container / Host Runtime Policies** — one shared endpoint
  (`/api/v2/runtime_policies`, `type` body field), covering drift prevention,
  executable/registry/OS-user allow-denylists, malware scanning,
  file-integrity monitoring, reverse-shell/exec controls, port blocking and
  auditing.
- **Firewall Policies** — ICMP/metadata-service blocking plus inbound/outbound
  network rules (authored as JSON, this canvas schema's escape hatch for
  genuinely nested multi-field list data) over `/api/v2/firewall_policies`.
- **Application Scopes** — image-artifact, Kubernetes-workload and
  Kubernetes-infrastructure scoping expressions over
  `/api/v2/access_management/scopes`, referenced by name from every policy
  type above.
- **Enforcer Groups** — protection-control configuration (container/host/
  network/image protections, admission control, orchestrator targeting,
  allow-lists, scheduled scan) over `/api/v1/hostsbatch`. Configuration only —
  installer/token/host-registration is out of scope (see README).

Auth is a dedicated Aqua user (id/email + password) exchanged for a session
JWT via `POST /api/v1/login`, matching the official Terraform provider's own
token-auth flow. Targets the Aqua CSP/Enterprise Console (self-hosted or
single-tenant Aqua-hosted); Aqua SaaS's multi-region tenant-resolution auth
is a documented future addition, not required for this surface.
