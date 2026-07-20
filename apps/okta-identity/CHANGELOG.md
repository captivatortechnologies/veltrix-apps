# Changelog

All notable changes to the Okta app are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 1.7.1 — 2026-07-20

### Fixed
- Saving a Connection now also registers its **deploy target** (an `okta-org`
  component whose hostname is the connection's endpoint, linked to the
  credential and environment). Previously a connection created only a credential,
  so Deploy stayed disabled ("register an okta-org connection to deploy") even
  though the connection tested green. Re-saving an existing connection back-fills
  its target. Requires app-sdk ≥ 3.3.0.

## 1.7.0 — 2026-07-20

### Changed
- Grouped the **Configurations** sidebar into 10 collapsible sections — Policies
  & Rules, Authentication, Directory, Applications, Authorization Servers,
  Network & Security, IAM Governance, Profile & Schema, Integrations, and
  Branding & Notifications — so all 32 configuration types stay navigable.
  Sections collapse by default, remember whether you left them open, and always
  expand the one you're currently working in.
