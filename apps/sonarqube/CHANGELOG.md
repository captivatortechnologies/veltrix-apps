# Changelog

All notable changes to the SonarQube app are documented here.

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **Quality Gates** config type — create / edit SonarQube quality gates (name,
  default flag, and pass/fail conditions authored as `<metric> <LT|GT> <threshold>`,
  e.g. `new_coverage LT 80`) over the SonarQube Web API (`/api/qualitygates`), with
  validate / deploy (upsert gate by name + reconcile conditions by metric) / rollback
  (destroy created gates, restore prior conditions, restore prior default) /
  health-check / drift-detect / status.
- **Connectivity test** against the SonarQube Web API (`/api/system/status` +
  `/api/authentication/validate`, HTTP or HTTPS, self-signed TLS tolerated) using a
  SonarQube token (HTTP Basic with the token as username and empty password).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (token →
  connection → author), and Connections (wraps the SDK `ConnectionsManager` for a
  SonarQube server; saving a connection registers `sonarqube-server` as a deploy
  target).

> SonarQube Web API paths and parameters follow the documented Web API
> (docs.sonarsource.com) and should be verified against your SonarQube version. TLS
> verification is off by default (self-signed tolerated) and configurable via the
> `verify_tls` setting.
>
> **Planned:** BYOL infrastructure hosting — provision and manage a SonarQube server
> (SonarQube + PostgreSQL) — ships in a later release, following the pattern used by
> the MISP app.
