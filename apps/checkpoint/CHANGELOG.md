# Changelog

All notable changes to the Check Point app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-02

### Added
- **Network hosts (`network-hosts`).** Manage Check Point Management API host
  objects as code through `add-host` / `set-host` / `delete-host`, reconciled
  by object name against `show-hosts`. Missing hosts are created, existing
  hosts are updated to the declared spec (IPv4/IPv6 address, comments, color,
  tags), and hosts this app previously created but no longer declares are
  removed. Ships the full handler set (validate, deploy, rollback,
  healthCheck, driftDetect, getStatus).
- **Session lifecycle client (`lib/checkpointApi.ts`).** A from-scratch
  Management API client implementing the login → act → publish/discard →
  logout unit of work: `POST /web_api/login` with either a username/password
  or an API key, `X-chkp-sid` on every subsequent call, `publish` on success,
  `discard` on any error, `logout` always. Talks to the Management Server over
  `node:https` with a dedicated `https.Agent` so the "Verify TLS certificate"
  setting genuinely controls whether a self-signed management certificate is
  accepted (off by default, matching the common on-prem default).
- **Connection test.** Login → a bounded `show-hosts` read (`limit: 1`) →
  logout — verifies the host, credential and Management API session model
  without making or publishing any change.
