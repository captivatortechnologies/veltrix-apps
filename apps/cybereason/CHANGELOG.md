# Changelog

All notable changes to the Cybereason app are documented here. This project
follows [Keep a Changelog](https://keepachangelog.com/) conventions and
[semantic versioning](https://semver.org/).

## 0.1.0 — 2026-08-01

Initial foundation release.

- New Veltrix app **Cybereason** (category **EDR**) managing the Cybereason
  Defense Platform over its REST API.
- Session-cookie access seam (`lib/cybereasonApi.ts`): username / password login
  to `/login.html` → `JSESSIONID` cookie, replayed on every `/rest/...` call.
- **Custom Reputations** configuration type — allowlist / blocklist entries for
  file hashes (MD5 / SHA-1), domains and IPv4 addresses, with a full pipeline:
  validate, deploy (upsert by key via `POST /rest/classification/update`),
  rollback (restore prior verdict or remove), health check, drift detection
  (against `GET /rest/classification/download`) and status.
- Connection-level connectivity test (`handlers/testConnection.ts`): session
  login + a bounded authenticated read.
- Client pages: Overview, Setup Guide, Connections.
