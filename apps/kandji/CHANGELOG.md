# Changelog

All notable changes to the Kandji app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-05

### Added — initial release

First release of the Kandji (Apple device management / MDM) config-as-code app, built research-first
directly against Kandji's own rendered API reference (`api-docs.kandji.io`, now serving from
`api-docs.iru.com` following the vendor's rebrand to Iru — see README for what changed and what didn't)
and its published `kandji-inc/support` GitHub example scripts, not documentation assumptions.

Four configuration types, covering Kandji's clearest declarative, round-trippable surface reachable
through the tenant API (`https://<subdomain>.api.kandji.io/api/v1/...`, Bearer API token):

- **Blueprints** (`config-types/blueprints`) — the core device-assignment construct: name, description,
  icon/color, enrollment code and active state via `/api/v1/blueprints`. `type` (classic vs. Assignment
  Map) is accepted on create only.
- **Tags** (`config-types/tags`) — tenant tags via `/api/v1/tags`.
- **Custom Scripts** (`config-types/custom-scripts`) — Library "Custom Script" items (execution
  frequency, script body, remediation script, restart flag, Self Service visibility) via
  `/api/v1/library/custom-scripts`.
- **Custom Profiles** (`config-types/custom-profiles`) — Library "Custom Profile" items via
  `/api/v1/library/custom-profiles`. The `.mobileconfig` plist payload is an opaque passthrough, the same
  posture `apps/jamf`'s macOS configuration profiles config type takes — transported as a multipart file
  part per Kandji's own API shape, not an embedded JSON string.

Authentication is a single tenant-scoped Bearer API token generated in Kandji's Settings > Access; the
Connection's endpoint IS the tenant API host (no separate subdomain/region setting), mirroring the
pattern `apps/okta-identity` and `apps/pagerduty` use.

See **Coverage** in `README.md` for the full breakdown of what's covered in this release versus deferred
(Custom Apps and In-House Apps need a multi-step S3 binary-upload flow this platform does not broker;
Self Service Categories is list-only in the API; Blueprint Routing / `assign-library-item` has an
unresolved documentation ambiguity between its Assign and Remove examples — and why).
