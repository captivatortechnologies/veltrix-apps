# Cybereason

Manage the **Cybereason Defense Platform** as code through its REST API. Author
custom reputations, sensor groups, isolation rules, sensor policies and
per-sensor tags in the Configuration Canvas and drive them through the
Security-as-Code pipeline — validate, deploy, health check, drift detection and
rollback.

- **Category:** EDR
- **Version:** 0.3.0

## What it manages

| Configuration type | Cybereason API | Notes |
| --- | --- | --- |
| **Custom Reputations** | `POST /rest/classification/update`, `GET /rest/classification/download` | Allowlist / blocklist entries for file hashes (MD5 / SHA-1), domains and IPv4 addresses. Optional *prevent execution* (Application Control) on a blocklisted file hash. Identity: the `key`. |
| **Sensor Groups** | `GET/POST /rest/groups`, `PUT/DELETE /rest/groups/{id}` | Sensor groups (name, description, assigned `policyId`, optional dynamic `groupAssignRule`). Upserted **by name**; delete reassigns sensors to the Unassigned group. Identity: the group `name`. |
| **Isolation Rules** | `GET/POST/PUT /rest/settings/isolation-rule`, `POST .../delete` | Isolation (exception) rules — which traffic is blocked / allowed while a sensor is isolated (`ipAddressString`, `direction`, `port`, `blocking`). Upserted by the **composite** `ip + direction + port`; update carries the live rule's `lastUpdated` concurrency token. |
| **Sensor Policies** | `GET/POST /rest/policies`, `GET/PUT/DELETE /rest/policies/{id}` | Prevention/detection policy (anti-malware, anti-exploit, anti-ransomware, application control, PowerShell protection, behavioral rules engine, ...), authored as one JSON blob. Upserted **by name**; delete reassigns sensors to the tenant's default policy. Identity: the policy `name`. **PUT (update) is FLAGGED / unverified — see below.** |
| **Sensor Tags** | `POST /rest/tagging/process_tags` (read via `POST /rest/sensors/query`) | Per-sensor tags — department, location, device type, critical asset, custom tags. A field left blank removes that tag. Identity: the sensor `pylumId`. |

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

## Sensor policies

A policy's authoring identity is its **name** (`configuration.nameDescription.name`
/ `metadata.name`). The full prevention/detection schema — anti-malware,
anti-exploit, anti-ransomware (`arw`), application control, PowerShell
protection, the behavioral rules engine (`rulesEngine`), collection features,
auto-upgrades, response/remediation posture, infrastructure — is large and
deeply nested, so it is authored as **one JSON blob** (`configuration`), the
same approach Cisco Meraki's Group Policies / singleton-settings config types
use for an equally large vendor schema. The typed `name` / `description` /
`notes` fields always win over the same keys inside the blob's
`nameDescription`. Only a small set of well-known, **live-tenant-confirmed**
enum fields are validated (anti-malware detect/prevent mode, anti-exploit
mode, ARW mode/level, rules-engine mode); the rest passes through as declared
and Cybereason validates it at deploy time. Drift recursively compares every
key actually **declared** in the blob against the live policy, at any nesting
depth — not a fixed whitelist.

Deploy reads the live policies (`GET /rest/policies`), then `PUT
/rest/policies/{id}` when a policy of that name already exists or `POST
/rest/policies` otherwise (the create response shape is not independently
confirmed, so deploy re-lists and matches by name to recover the new policy's
id). Rollback restores the prior `configuration`, or `DELETE
/rest/policies/{id}?assignToPolicyId=…` for a policy this deploy created —
reassigning its sensors to the tenant's **default** policy, discovered by
scanning policy detail for `metadata.isDefault` (Policies has no fixed
sentinel id the way Groups has `00000000-…`).

> **FLAGGED — updating an existing policy is unverified.** List / get / create
> / delete against `/rest/policies` are confirmed against
> `forensic-security/cybereason`'s Python SDK *and* that repo's
> live-tenant-recorded JSON Schema test suite. Neither that SDK nor the
> actively-maintained Cortex XSOAR Cybereason integration implement a policy
> **update** call, and Cybereason's official API docs require a customer
> login. `PUT /rest/policies/{id}` is inferred only by symmetry with the
> confirmed `PUT /rest/groups/{id}` on the same tenant. Deploy surfaces a
> clear, specific failure — never a silent no-op — if a tenant rejects it, and
> `validate` emits a standing warning. **Verify this against your own tenant
> before relying on policy updates in production.**

## Sensor tags

Per-sensor metadata tags — department, location, device type, critical asset,
custom tags — identified by the sensor's Cybereason `pylumId` (independent of
Sensor Groups, which assign a policy). Each field maps to a `SET` (value
present) or `REMOVE` (field left blank) operation sent to `POST
/rest/tagging/process_tags`, reproducing the API's literal wire tag names
verbatim (`"device type"`, `"critical asset"`, `"custom tags"` — note the
spaces, and the asymmetry with the camelCase field names — `deviceType`,
`criticalAsset`, `customTags` — returned by the read side, `POST
/rest/sensors/query`). `criticalAsset` is authored as a tri-state (unset /
true / false) since leaving it unset REMOVES the tag entirely, rather than
setting it to `false`. Deploy snapshots each sensor's current tags before
writing so rollback can restore the prior value per tag, or remove a tag that
had none before. `customTags` is capped at 100 characters, matching
Cybereason's own client-side limit.

## Pipeline handlers

Each configuration type lives in `config-types/<id>/` — `validate`, `deploy`,
`rollback`, `healthCheck`, `driftDetect`, `getStatus`, plus shared helpers in
`_shared.ts` and tests in `__tests__/`:
`reputations`, `sensor-groups`, `isolation-rules`, `sensor-policies`, `sensor-tags`.

## Development

```
cd apps/cybereason
node node_modules/typescript/bin/tsc --noEmit          # typecheck
node ../../scripts/test-apps.mjs cybereason            # run handler tests
node ../../scripts/validate-app.mjs apps/cybereason    # validate against the app contract
```

## Coverage (v0.3.0)

Coverage was audited against the Cybereason REST API as exposed by two
independent public clients (`forensic-security/cybereason` — an actively
maintained async Python SDK whose test suite validates response shapes
against a **live tenant** — and `tobor88/CybereasonAPI`, a PowerShell module),
plus the actively-maintained Cortex XSOAR Cybereason integration
(`demisto/content`). Cybereason's own API documentation
(`nest.cybereason.com`, `api-doc.cybereason.com`) requires a customer login
and could not be independently checked.

### Managed declarative configuration

| Configuration type | REST operations | Confirmation |
| --- | --- | --- |
| Custom reputations | `GET /rest/classification/download`, `POST /rest/classification/update` | Confirmed (2 independent clients) |
| Sensor groups | `GET/POST /rest/groups`, `PUT/DELETE /rest/groups/{id}` | Confirmed (2 independent clients) |
| Isolation rules | `GET/POST/PUT /rest/settings/isolation-rule`, `POST .../delete` | Confirmed (2 independent clients) |
| Sensor policies | `GET/POST /rest/policies`, `GET/DELETE /rest/policies/{id}` | Confirmed (1 client + live-tenant-recorded schema) |
| Sensor policies — **update** | `PUT /rest/policies/{id}` | **Unverified** — inferred by symmetry with Groups; see "Sensor policies" above |
| Sensor tags | `POST /rest/tagging/process_tags`, `POST /rest/sensors/query` | Confirmed (1 client) |

### Intentionally excluded

- **Custom Detection Rules** (custom malop rules) — the endpoints exist
  (`/rest/customRules/decisionFeature/{live,deleted,create,update}`, with a
  `/rest/v2/…` split on newer tenants), but a valid create/update body is a
  nested *Element → Feature → filter* graph needing correct `elementType` /
  `facetName` / `connectionFeature` values plus `malopDetectionType` /
  `malopActivityType` / `rootCause` enums drawn from separate catalog
  endpoints. Not a flat, round-trippable config object — dropped rather than
  shipped as a misleading best-effort surface.
- **An alternate, newer reputations surface**
  (`dynamic/v1/ti-reputation/api/v1/lists/{listId}/reputations`, with
  per-group scoping and expiry) exists alongside the already-shipped
  `classification/update` reputations this app manages. Not added: it would
  duplicate the existing, well-confirmed Custom Reputations type; the Python
  SDK's own equivalent method is commented out by its author; and its create
  path is not clearly round-trippable from public sources.
- **Exclusion / allow rules** are not a separate endpoint — file/process/
  registry exclusions live **inside** a Sensor Policy's `configuration` JSON
  (`antiMalware.exclusions`, `antiExploit.antiExploitExclusions`,
  `rulesEngine.pathExclusions`, `powershellProtection.*Exclusions`).
- **Response / remediation policy** (the fully-automated-response toggle,
  `configuration.response.enabled`) is covered via Sensor Policies, the same
  way. Actual remediation ACTIONS (kill process, quarantine file, isolate /
  unisolate a sensor) are imperative operations, not durable desired state,
  and remain out of scope.
- **Users / roles** — only read-only endpoints (`GET /rest/users`, `GET
  /rest/users/{username}`) and a self-service password reset were found in
  any source checked; no create/update/delete-user or role-assignment
  endpoint. Even if one existed, platform user/role administration is
  security-sensitive identity bootstrap, not canvas configuration.
- **Notification config** — `GET /rest/settings/configurations` is a
  read-only audit/change-log feed ("details on settings updates"), not a live
  settings object with a write counterpart; no notification/syslog/webhook/
  SMTP write endpoint was found.
- **Malop labels** (`detection/labels`, `add-label`, `labels/delete`) — a
  create/delete-only triage-taxonomy catalog for alerts, not prevention/
  detection configuration. Out of category for this app.
- Malops, alerts, sensor inventory/status, remote-shell sessions, incident-
  response tooling, forensic file/log downloads, and the user audit log are
  read/imperative surfaces, not durable desired state.

## Accuracy notes (verify against a live Cybereason)

- Login success/failure signalling (a `302` redirect vs a `200` login page) and
  the `classification/update` response body are modelled from public
  integrations, not an official API contract.
- The `classification/download` CSV column layout is inferred; the parser matches
  columns by header substring (`key` / `reputation|type|maliciousType` /
  `prevent` / `comment`) so it tolerates ordering and naming differences.
- Cybereason file reputations key on **MD5 or SHA-1** — SHA-256 is not supported.
- Sensor Policies: the `PUT /rest/policies/{id}` update endpoint is unverified
  (see "Sensor policies" above) — the single highest-priority item to confirm
  against a live tenant before production use.
