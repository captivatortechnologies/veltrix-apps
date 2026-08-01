# Changelog

All notable changes to the JumpCloud app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-08-01

Initial release — foundation + first config type.

- **User Groups** config type — create / edit / delete JumpCloud User Groups (name, description,
  email, membership method STATIC / DYNAMIC_AUTOMATED) over the JumpCloud API v2 (`/usergroups`), with
  validate / deploy (upsert by name, rename-safe id tracking) / rollback (restore prior or delete
  created) / health-check / drift-detect / status.
- **Connectivity test** against the JumpCloud API (`GET /api/v2/usergroups`) using an `x-api-key`
  header (plus optional `x-org-id` for multi-tenant admins).
- **Client** — Overview (fed by the app's `/meta` route), Setup Guide (API key → credential → author),
  and Connections (wraps the SDK `ConnectionsManager` against the fixed JumpCloud endpoint; saving a
  connection registers `jumpcloud-org` as a deploy target).

> The JumpCloud API endpoint is fixed (`https://console.jumpcloud.com/api`, v2 under `/api/v2`).
> The `POST`/`PUT` body fields beyond `name` (`description`, `email`, `membershipMethod`) should be
> verified against a live JumpCloud tenant.
