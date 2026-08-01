# Cybereason

Manage the **Cybereason Defense Platform** as code through its REST API. Author
custom reputations in the Configuration Canvas and drive them through the
Security-as-Code pipeline — validate, deploy, health check, drift detection and
rollback.

- **Category:** EDR
- **Version:** 0.2.0

## What it manages

| Configuration type | Cybereason API | Notes |
| --- | --- | --- |
| **Custom Reputations** | `POST /rest/classification/update`, `GET /rest/classification/download` | Allowlist / blocklist entries for file hashes (MD5 / SHA-1), domains and IPv4 addresses. Optional *prevent execution* (Application Control) on a blocklisted file hash. Identity: the `key`. |
| **Sensor Groups** | `GET/POST /rest/groups`, `PUT/DELETE /rest/groups/{id}` | Sensor groups (name, description, assigned `policyId`, optional dynamic `groupAssignRule`). Upserted **by name**; delete reassigns sensors to the Unassigned group. Identity: the group `name`. |
| **Isolation Rules** | `GET/POST/PUT /rest/settings/isolation-rule`, `POST .../delete` | Isolation (exception) rules — which traffic is blocked / allowed while a sensor is isolated (`ipAddressString`, `direction`, `port`, `blocking`). Upserted by the **composite** `ip + direction + port`; update carries the live rule's `lastUpdated` concurrency token. |

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

## Sensor groups

A sensor group's authoring identity is its **name**. Deploy reads the live groups,
`PUT`s the matching group by its GUID `id` when the name already exists, or `POST`s
a new one otherwise (Cybereason returns the new `groupId`). Rollback restores the
prior body or deletes a group this deploy created, reassigning its sensors to the
Unassigned group. The dynamic `groupAssignRule` is **FLAGGED** — its inner schema
is unverified, so it is passed through as opaque JSON and only checked for JSON
validity.

## Isolation rules

Cybereason assigns each rule a server-side `ruleId`, so the **composite** of
`ipAddressString + direction + port` is used as the config identity. `blocking:
true` blocks matching traffic while a sensor is isolated; `false` allows it through
(an isolation exception). `port` `0` means any port; blank means no port
restriction. Update requires the rule's current `lastUpdated` (an
optimistic-concurrency token), so both deploy and rollback read live state before
writing.

## Pipeline handlers

Each configuration type lives in `config-types/<id>/` — `validate`, `deploy`,
`rollback`, `healthCheck`, `driftDetect`, `getStatus`, plus shared helpers in
`_shared.ts` and tests in `__tests__/`:
`reputations`, `sensor-groups`, `isolation-rules`.

## Scope — what is *not* managed (be honest)

**Custom Detection Rules** (custom malop rules) were researched and **dropped**.
The endpoints exist (`/rest/customRules/decisionFeature/{live,deleted,create,update}`,
with a `/rest/v2/…` split on newer tenants), but a valid create/update body is a
nested *Element → Feature → filter* graph that needs correct `elementType` /
`facetName` / `connectionFeature` values plus `malopDetectionType` /
`malopActivityType` / `rootCause` enums drawn from separate catalog endpoints. It
is not a flat, round-trippable config object and is not realistically maintainable
as declarative code from public sources, so it was left out rather than shipped as
a misleading best-effort surface.

## Accuracy notes (verify against a live Cybereason)

- Login success/failure signalling (a `302` redirect vs a `200` login page) and
  the `classification/update` response body are modelled from public
  integrations, not an official API contract.
- The `classification/download` CSV column layout is inferred; the parser matches
  columns by header substring (`key` / `reputation|type|maliciousType` /
  `prevent` / `comment`) so it tolerates ordering and naming differences.
- Cybereason file reputations key on **MD5 or SHA-1** — SHA-256 is not supported.
