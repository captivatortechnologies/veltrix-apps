# Cybereason

Manage the **Cybereason Defense Platform** as code through its REST API. Author
custom reputations in the Configuration Canvas and drive them through the
Security-as-Code pipeline — validate, deploy, health check, drift detection and
rollback.

- **Category:** EDR
- **Version:** 0.1.0 (foundation)

## What it manages

| Configuration type | Cybereason API | Notes |
| --- | --- | --- |
| **Custom Reputations** | `POST /rest/classification/update`, `GET /rest/classification/download` | Allowlist / blocklist entries for file hashes (MD5 / SHA-1), domains and IPv4 addresses. Optional *prevent execution* (Application Control) on a blocklisted file hash. |

## Authentication

Cybereason uses a **session-cookie** login:

1. The app posts an `application/x-www-form-urlencoded` body with `username` and
   `password` to `https://<tenant>.cybereason.net/login.html`.
2. On success Cybereason returns a `JSESSIONID` cookie.
3. That cookie is replayed as `Cookie: JSESSIONID=…` on every subsequent
   `/rest/...` JSON call.

Store the account's **username and password** as a Veltrix credential on the
**Connections** page, pointing at your tenant URL
(`https://<tenant>.cybereason.net`). Cybereason SaaS tenants present a valid TLS
certificate, so certificate verification is enforced.

## Custom reputations

A reputation's identity is its **key** — the file hash, domain, or IP value.
Cybereason keys are unique across the whole custom reputation list, so the key is
used for upsert (`remove: false`) and drift. `keyType` is an authoring aid: the
Cybereason API infers the type from the key itself.

| Field | Meaning |
| --- | --- |
| `keyType` | `file` (MD5 / SHA-1 hash), `domain`, or `ipv4`. |
| `key` | The hash / domain / IP value. Identity field. |
| `reputation` | `whitelist` (allowlist) or `blacklist` (blocklist) → sent as `maliciousType`. |
| `preventExecution` | Block execution via Application Control. Only applied to a **blocklisted file hash** — forced off otherwise. |
| `comment` | Free-text note recorded for audit. |

Deploy snapshots the prior verdict of every key (from the reputations CSV) into
`rollbackData`, so rollback restores the prior verdict or removes a key that had
no custom reputation before.

## Pipeline handlers

`config-types/reputations/` — `validate`, `deploy`, `rollback`, `healthCheck`,
`driftDetect`, `getStatus`, plus shared helpers in `_shared.ts` and tests in
`__tests__/`.

## Accuracy notes (verify against a live Cybereason)

- Login success/failure signalling (a `302` redirect vs a `200` login page) and
  the `classification/update` response body are modelled from public
  integrations, not an official API contract.
- The `classification/download` CSV column layout is inferred; the parser matches
  columns by header substring (`key` / `reputation|type|maliciousType` /
  `prevent` / `comment`) so it tolerates ordering and naming differences.
- Cybereason file reputations key on **MD5 or SHA-1** — SHA-256 is not supported.
