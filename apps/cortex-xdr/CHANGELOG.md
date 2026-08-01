# Changelog

All notable changes to the Cortex XDR app are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.1.0 — 2026-07-31

### Added

- **Initial foundation** for managing Palo Alto Networks Cortex XDR configuration
  as code over the Cortex XDR public REST API. Config-as-code only — no database,
  no infrastructure provisioning.
- **Cortex XDR REST client** (`lib/cortexXdrApi.ts`): POSTs the
  `{ request_data }` envelope, unwraps `{ reply }`, and signs every request with
  **Standard**-security auth headers (`x-xdr-auth-id` + `Authorization`). Includes
  a connectivity/health probe and a clearly-commented seam for **Advanced**
  (nonce + timestamp + SHA256 HMAC) auth as a follow-up.
- **Threat Indicators (IOCs)** configuration type (`config-types/iocs`) with the
  full handler set — validate, deploy, rollback, healthCheck, driftDetect,
  getStatus — plus a canvas covering indicator value, type
  (`HASH`/`IP`/`DOMAIN_NAME`/`PATH`/`FILENAME`), severity
  (`INFO`/`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`), reputation
  (`GOOD`/`BAD`/`SUSPICIOUS`/`UNKNOWN`), reliability (`A`–`F`), comment and an
  optional epoch-millis expiration. Deploy upserts by indicator value via
  `POST /indicators/insert_jsons/`; rollback restores prior bodies or deletes
  created indicators via `POST /indicators/delete/`.
- **Connections** page (`cortex-xdr-tenant` component) + a `testConnection`
  handler that probes `POST /public_api/v1/endpoints/get_endpoint_groups/`, and
  **Overview** + **Setup Guide** pages.

### Notes

- The exact indicator endpoint paths, request envelopes, field names and enum
  values are marked `VERIFY against live Cortex XDR` in the code — confirm them
  against a live tenant before production use.
