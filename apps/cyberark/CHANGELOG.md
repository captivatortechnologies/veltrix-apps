# Changelog

All notable changes to the CyberArk Privileged Access Manager app are documented
here. This project adheres to [Semantic Versioning](https://semver.org/).

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
