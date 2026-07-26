# Changelog

All notable changes to the Proofpoint Essentials app are documented here.

## 1.1.0 — 2026-07-26

### Added

- **Proofpoint Organization Features** (`pp-org-features`) configuration type —
  manage the organization's security/protection features as code through the
  Essentials Interface API features resource (`GET`/`PUT /orgs/{org}/features`).
  Covers the documented boolean features: **URL Defense** (`url_defense`),
  **Attachment Defense** (`attachment_defense`) and its **sandboxing**
  (`attachment_defense_sandboxing`), **Anti-Spoofing** (`anti_spoofing`),
  **DLP** (`dlp`), **Email Encryption** (`email_encryption`), **Email Warning
  Tags** (`email_warning_tags`), **Email Archive** (`email_archive`),
  **Disclaimers** (`disclaimers`), **Social Media Account Protection**
  (`social_media_account_protection`), **Outbound Relaying**
  (`outbound_relaying`), **SMTP Discovery** (`smtp_discovery`), **One-Click
  Remediation** (`one_click_remediation`) and **Automatic Remediation**
  (`automatic_remediation`). Reconciled by feature name with a read-modify-write
  `PUT` (features it did not declare are preserved), full drift detection, health
  check and rollback to the captured prior values.

### Notes

- Feature availability depends on the organization's Essentials licensing
  package; enabling a feature the package does not include is rejected by
  Proofpoint with `HTTP 403`, which the deploy surfaces verbatim.
- `instant_replay` is intentionally excluded: the Interface API documents it as
  the one non-boolean feature, so it cannot be reconciled with a simple on/off
  toggle.
