# Changelog

All notable changes to the Sumo Logic app are documented here. This project
follows [Keep a Changelog](https://keepachangelog.com/) conventions and semver.

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
