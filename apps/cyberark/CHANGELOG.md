# Changelog

All notable changes to the CyberArk Privileged Access Manager app are documented
here. This project adheres to [Semantic Versioning](https://semver.org/).

## 1.2.0 — 2026-07-26

### Added
- **Platforms configuration type.** Manage CyberArk target platforms as code
  through the PVWA REST API. Each item is reconciled by its **PlatformID**
  (`GET /PasswordVault/API/Platforms/Targets`):
  - A platform that does not yet exist is **imported** from a supplied BASE 64
    platform package (`POST /PasswordVault/API/Platforms/Import`). The package
    field is **write-only** — sent only on import and never read back, diffed, or
    stored in rollback data, artifacts or logs (mirrors the account-secret rule).
  - The platform's **active state** is enforced with
    `POST /PasswordVault/API/Platforms/Targets/{id}/activate` /
    `…/deactivate`.
  - Rollback deletes an imported platform
    (`DELETE /PasswordVault/API/Platforms/Targets/{id}`) and restores a changed
    platform's prior active state. Drift and health checks report a missing
    platform and any active-state mismatch.
- **Automatic onboarding rules configuration type.** Manage CyberArk automatic
  onboarding rules as code (`/PasswordVault/API/AutomaticOnboardingRules`),
  reconciled by the unique **rule name**. Discovered accounts that match a rule
  are onboarded to the rule's target Safe against its target platform.
  - Create (`POST`), full-replace update (`PUT …/{id}`) and rollback delete
    (`DELETE …/{id}`) are all supported; the target platform/safe, system &
    machine type, account category, admin-ID, username and address filters (with
    match methods) and description are managed declaratively. Drift and health
    checks report a missing rule and any changed field.

### Notes
- **Master Policy / per-platform privileged access workflows are read-only over
  REST.** CyberArk exposes each platform's privileged access workflows (dual
  control, exclusive check-in/check-out, one-time password access,
  reason-for-access) on `GET /Platforms/Targets`, but the only writable platform
  endpoints are import, activate/deactivate and rename — there is no REST API to
  set these workflow settings or the Master Policy (they are configured via the
  platform package or the PVWA UI). This app therefore does not offer a
  deployable "privileged access policy" type; the Platforms type manages the
  platforms that carry those settings via import/activate.

## 1.1.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed CyberArk object, each reported difference is now annotated with the
  person who made the last change and when. The platform stores the `actor` on
  each diff and the drift view renders it, so a drift alert answers *who* and
  *when*, not just *what*.
  - **Accounts** are attributed from the per-account Activities log
    (`GET /Accounts/{id}/Activities`), which records every action with its
    `User`, `Date` and `Action`. Attribution picks the most recent human,
    non-Veltrix activity, preferring change-type actions (modify / update / add /
    rename / change / enable / disable / …) and excluding the CPM component's
    automated rotations, so it reflects a *manual* change.
  - **Safes** are attributed from the `creator` principal and `creationTime` /
    `lastModificationTime` the PVWA already returns on the safe object, so no
    extra API call is made. CyberArk records only the creator identity on a safe
    (not a distinct last-modifier), so a safe is attributed to its creator — the
    closest attribution the Gen2 API affords — with the timestamp reflecting its
    last modification.
  - **Safe members** carry no creator/modifier metadata in the Gen2 API and have
    no per-member activity endpoint, so member diffs cannot be attributed with
    the app's credentials and are reported without an actor (the drift view shows
    "—").
  - Veltrix's own deploys are recorded under the connection's manager account, so
    a change WE made is excluded via that username — the attribution reflects the
    *manual* change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, an empty log, a missing source, or no usable human
    event, the diff is reported without an actor. Only objects that actually
    drifted are resolved (one resolution per drifted object).
