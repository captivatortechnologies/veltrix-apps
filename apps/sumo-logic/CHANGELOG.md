# Changelog

All notable changes to the Sumo Logic app are documented here. This project
follows [Keep a Changelog](https://keepachangelog.com/) conventions and semver.

## 0.2.0 — 2026-08-01

Three new configuration types, each a full Security-as-Code pipeline (validate,
deploy, rollback, health check, drift detection and status) over the Sumo Logic
Management API.

- **Partitions** (`/api/v1/partitions`) — manage index partitions as code: name,
  routing expression, retention period and data tier. Upsert by name; update
  sends only the mutable subset (name and tier are immutable in Sumo Logic).
  Rollback restores the prior routing/retention or **decommissions** a newly
  created partition — partitions cannot be deleted, only decommissioned
  (`POST /partitions/{id}/decommission`).
- **Custom Fields** (`/api/v1/fields`) — manage the metadata-tag field schema and
  each field's enabled state. Deploy creates a field (`POST /fields`) then
  converges its state via the dedicated `PUT /fields/{id}/enable` /
  `DELETE /fields/{id}/disable` endpoints. Rollback restores the prior state or
  deletes a newly created field.
- **Roles** (`/api/v1/roles`) — manage RBAC roles: name, description, search
  filter (`filterPredicate`) and capabilities. Upsert by name; user membership is
  left untouched. Rollback restores the prior role body or deletes a newly created
  role.
- Added a reusable paged-list helper (`listPaged`) to the Sumo Logic access lib
  for the token-paginated partitions and roles endpoints.

Endpoints and object shapes verified against the official Sumo Logic API docs and
the SumoLogic terraform provider. Note: the exact `analyticsTier` values a
partition accepts depend on the account's Data Tiers / Flex entitlement, and role
`capabilities` names must match Sumo Logic's capability list.

## 0.1.0 — 2026-08-01

Initial foundation release.

- Manage **Field Extraction Rules** (FERs) as code over the Sumo Logic Management
  API (`/api/v1/extractionRules`), authenticated with an Access ID / Access Key
  (HTTP Basic).
- Full Security-as-Code pipeline for the `field-extraction-rules` configuration
  type: validate, deploy (upsert by rule name), rollback (restore prior body or
  delete a newly created rule), health check, drift detection and status.
- Connections page pairing a Sumo Logic deployment endpoint with an Access ID /
  Access Key, plus a per-connection connectivity test.
- Overview and Setup Guide pages.
