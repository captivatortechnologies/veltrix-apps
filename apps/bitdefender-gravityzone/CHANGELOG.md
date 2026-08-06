# Changelog

All notable changes to the Bitdefender GravityZone app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the Bitdefender GravityZone config-as-code app, built research-first directly against
Bitdefender's own GravityZone Public API support documentation
(`bitdefender.com/business/support/en/77209-*`, one page per method) and cross-checked against
[`DainArtz/n8n-nodes-gravityzone`](https://github.com/DainArtz/n8n-nodes-gravityzone), an independently
maintained TypeScript integration built directly against the same API.

The GravityZone Public API is **JSON-RPC 2.0**, not REST — one endpoint per service
(`POST https://<host>/api/v1.0/jsonrpc/<service>`) — authenticated with a single API key sent as HTTP
Basic (the key as username, an empty password). See README.md for the full JSON-RPC contract.

Nine configuration types, covering the genuinely declarative, round-trippable write surface this API
exposes:

- **Network Groups** (`config-types/network-groups`) — custom network groups/containers via
  `network.createCustomGroup`/`deleteCustomGroup`/`getCustomGroupsList`, reconciled by
  `(groupName, parentId)`. GravityZone assigns the group id on create and has no rename API.
- **Policy Assignments** (`config-types/network-policy-assignments`) — assign an existing policy (or
  restore inheritance) to a set of endpoint ids via `network.assignPolicy`, one of the few genuine
  policy writes this API exposes.
- **Policy Module States** (`config-types/policy-module-states`) — enable/disable an existing policy's
  protection modules via `policies.setPolicyModulesState`. GravityZone's Policies service is otherwise
  list/read-only (`getPoliciesList`, `getPolicyDetails`) — full policy authoring happens only in the
  Control Center console.
- **Installation Packages** (`config-types/installation-packages`) — installation package
  *configuration* (name, modules, scan mode, roles, deployment options) via the Packages service, not
  the installer binary itself. Reconciled by `packageName`.
- **Integrations** (`config-types/integrations`) — third-party integration configuration via the
  Integrations service, reconciled by `name`.
- **User Accounts** (`config-types/user-accounts`) — Control Center user accounts (email, role, rights,
  target scope) via the Accounts service, reconciled by `email`. `password` is write-only — see
  README.md "Known limitations".
- **Notification Settings** (`config-types/notification-settings`) — per-account notification
  preferences via `accounts.configureNotificationsSettings`/`getNotificationsSettings`.
- **Company Profile** (`config-types/company-profile`) — the company/tenant profile (name, address, 2FA
  enforcement, contacts) via `companies.updateCompanyDetails`/`getCompanyDetails`.
- **Push Event Settings** (`config-types/push-event-settings`) — the tenant-wide outbound push
  notification (webhook/SIEM) integration via the Push service. A singleton.

See **Coverage** in `README.md` for the full breakdown of what's covered versus deliberately excluded
(full policy authoring, `network.moveCustomGroup`, `network.setEndpointLabel`, one-shot scan/quarantine/
incident-response actions, read-only inventory and reports, installer binaries, licensing, maintenance
windows/patch management/PHASR, and Amazon EC2 cloud-account integration setup) and why.
