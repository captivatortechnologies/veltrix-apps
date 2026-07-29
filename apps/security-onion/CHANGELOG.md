# Changelog

All notable changes to the Security Onion app are documented here.

## 0.1.0 — 2026-07-29

Initial release — foundation + first config type.

- **Suricata Rules** config type — enable/disable NIDS rules by SID across the
  grid, applied on the manager via `so-rule` + a Salt highstate over managed ZTNA,
  with validate / deploy / rollback (inverse-undo) / health-check / status.
- **Connectivity test** against the SOC console (HTTPS, self-signed tolerated).
- **BYOL infrastructure** groundwork: declarative `infra/spec.ts` composing the
  generic OpenTofu modules (manager / search / sensor / forward / fleet grid) +
  Salt bring-up entrypoint.
- Uses the platform's new app-declared `remoteCommands` seam so Salt/CLI grid
  operations run over managed ZTNA with per-param validation.

> Grid config is applied via Salt (`so-*`, `salt-call`) and the SOC/Elasticsearch
> REST APIs. Remote command paths follow Security Onion 2.4 conventions and should
> be verified against your grid; the managed-ZTNA remote path ships behind the
> platform's `REMOTE_EXEC_ENABLED` flag.
