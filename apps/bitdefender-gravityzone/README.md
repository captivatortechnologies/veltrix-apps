# Bitdefender GravityZone (Veltrix app)

Manage [Bitdefender GravityZone](https://www.bitdefender.com/business/) endpoint security configuration
as code through the **GravityZone Control Center Public API** — a **JSON-RPC 2.0** API, not REST — driven
by the Veltrix Security-as-Code pipeline (validate → deploy → health check → drift detect → rollback).

## The API is JSON-RPC, not REST

There is **one HTTP endpoint per service**:

```
POST https://<host>/api/v1.0/jsonrpc/<service>
Content-Type: application/json

{ "id": "<any>", "jsonrpc": "2.0", "method": "<methodName>", "params": { ... } }
```

The service selects the resource family (`network`, `policies`, `packages`, `accounts`, `companies`,
`push`, `integrations`, `general`) and the JSON-RPC `method` field selects the operation — not the HTTP
path or verb. A successful call returns `{"result": {...}}`; a failed one returns
`{"error": {"code", "message", "data"}}`. One method (`policies.getPolicyDetails`) is documented at API
version `v1.1` rather than the default `v1.0` (see `lib/gravityZoneApi.ts`).

Authentication is a single **API key** generated in the Control Center under **My Account > API keys**,
sent as HTTP Basic with the key as the username and an **empty password**:
`Authorization: Basic base64("<apiKey>:")`. There is no session or token exchange.

This app's client (`lib/gravityZone.ts`, `lib/gravityZoneApi.ts`) was built against Bitdefender's own
support documentation (`bitdefender.com/business/support/en/77209-*`, one page per method — cited per
method in `gravityZoneApi.ts`) and cross-checked against
[`DainArtz/n8n-nodes-gravityzone`](https://github.com/DainArtz/n8n-nodes-gravityzone), an independently
maintained, actively developed TypeScript integration built directly against this same public API — its
`transport/requestApi.ts` and `credentials/GravityZoneApi.credentials.ts` confirm the exact JSON-RPC
envelope, the HTTP Basic auth scheme, and the default API host
(`https://cloud.gravityzone.bitdefender.com/api`) this app uses.

## What it manages

| Configuration type | GravityZone service.method(s) | Identity |
| --- | --- | --- |
| **Network Groups** (`network-groups`) | `network.createCustomGroup`, `network.deleteCustomGroup`, `network.getCustomGroupsList` | `(groupName, parentId)` |
| **Policy Assignments** (`network-policy-assignments`) | `network.assignPolicy` | canvas-only `assignmentName` |
| **Policy Module States** (`policy-module-states`) | `policies.setPolicyModulesState`, `policies.getPoliciesList`, `policies.getPolicyDetails` | `policyId` |
| **Installation Packages** (`installation-packages`) | `packages.createPackage`, `packages.updatePackage`, `packages.deletePackage`, `packages.getPackagesList`, `packages.getPackageDetails` | `packageName` |
| **Integrations** (`integrations`) | `integrations.createIntegration`, `integrations.updateIntegration`, `integrations.deleteIntegration`, `integrations.getConfiguredIntegrations`, `integrations.getIntegrationDetails` | `name` |
| **User Accounts** (`user-accounts`) | `accounts.createAccount`, `accounts.updateAccount`, `accounts.deleteAccount`, `accounts.getAccountsList`, `accounts.getAccountDetails` | `email` |
| **Notification Settings** (`notification-settings`) | `accounts.configureNotificationsSettings`, `accounts.getNotificationsSettings` | `accountId` (blank = own account) |
| **Company Profile** (`company-profile`) | `companies.updateCompanyDetails`, `companies.getCompanyDetails` | `companyId` (blank = own company) |
| **Push Event Settings** (`push-event-settings`) | `push.setPushEventSettings`, `push.getPushEventSettings` | singleton |

Every method above cites its exact Bitdefender support-doc page as a comment in `lib/gravityZoneApi.ts`
(e.g. `https://www.bitdefender.com/business/support/en/77209-135303-getpolicieslist.html`).

### Why Policies is almost entirely list/read-only

This app's research reviewed **every documented method of the Policies service**. It exposes exactly
three: `getPoliciesList` (list), `getPolicyDetails` (read one), and `setPolicyModulesState` (toggle a
policy's protection modules on/off). There is no `createPolicy` or `updatePolicy` — a policy's name,
targets, and full rule tree are authored **only in the Control Center console**. This is not a gap in
this app's research; it is the genuine shape of the public API. `policy-module-states` is built around
the one write that exists, against an **existing, console-authored** policy — it never creates or
deletes a policy.

### Network — the real policy write, and what's deliberately excluded

`network.assignPolicy` is a genuine, documented write: it assigns an existing policy (or restores
inheritance) to a set of endpoint ids. `network-policy-assignments` is built around it.

`network.moveCustomGroup` and `network.setEndpointLabel` are also real, documented, write-capable
methods this app does **not** call:

- **`moveCustomGroup`** — relocating an existing group requires knowing its *current* parent.
  `network.getCustomGroupsList` only lists one parent's direct children at a time; there is no flat
  "list every group" call and no "get the parent of group X" call. Wiring `moveCustomGroup` into a
  declarative deploy without a reliable way to find a group's current location risked moving the wrong
  group. `network-groups` therefore reconciles by the pair `(groupName, parentId)` — a group is only
  ever looked for where it was declared — and never calls `moveCustomGroup`. To relocate a group, do so
  once in the console, or delete and redeclare it.
- **`setEndpointLabel`** — sets a single label string on an endpoint, but this app found **no
  corresponding read method** (no `getEndpointLabel`, and whether `network.getManagedEndpointDetails`'s
  response includes a label field was not independently confirmed). Declaring it here would be
  write-only with no way to detect drift or confirm success — excluded rather than shipped as a stub.

## Credentials

1. Sign in to the GravityZone Control Center, open the user menu, go to **My Account > API keys**, and
   generate a new key. Grant it every action category this app calls: **General, Network, Policy,
   Packages, Companies, Accounts, Push notifications, Integrations**. The key's value is shown only
   once — copy it immediately.
2. Store the key as a Veltrix credential's **"API token"** field — there is no separate username.
3. Register a **`gravityzone-tenant`** component whose hostname is your Control Center API host
   (`cloud.gravityzone.bitdefender.com` for the default Cloud console, or your on-premises/regional
   Control Center's hostname) and attach the credential.

The connectivity test calls `general.getApiKeyDetails` — the lightest documented method (no parameters)
— which both confirms the key is valid/enabled and identifies the account it belongs to.

## Coverage

This release covers nine configuration types across GravityZone's genuinely declarative,
round-trippable write surface. What's deliberately out of scope, and why:

| Candidate | Why it's not in this release |
| --- | --- |
| Full policy authoring (name, targets, rule tree) | Not exposed by the public API — see "Why Policies is almost entirely list/read-only" above. Only the one real write (`setPolicyModulesState`) is covered. |
| `network.moveCustomGroup` | No reliable way to find a group's *current* parent before moving it — see "Network" above. |
| `network.setEndpointLabel` | No corresponding read method this app could confirm — write-only with no drift detection. |
| One-shot scan/reconfigure/sandbox-submit tasks (`createScanTask`, `createReconfigureClientTask`, `createSubmitToSandboxAnalyzerTask`, `killProcess`, `runLiveSearchQuery`) | Actions, not declarative objects — the same reasoning every app in this catalog applies to one-shot operations. |
| Quarantine actions (`createRestoreQuarantineItemTask`, etc.) and Incident response actions | Response/remediation actions, not configuration. |
| Read-only inventory (`getEndpointsList`, `getNetworkInventoryItems`, patch inventory) and Reports | Read-only or one-shot report generation — nothing to declare or converge to. |
| Installation package **binaries** / installation links | `installation-packages` manages package *configuration* (modules, scan mode, roles) — the installer binary and download links are generated artifacts, not authored config. |
| Licensing (`setLicenseKey`, `addProductKey`, usage) | License keys are account-linked secrets/entitlements, not per-object declarative config. |
| Maintenance Windows, Patch Management, PHASR | Scheduling/remediation-workflow surfaces oriented around one-shot approvals and live recommendations, not stable declarative objects. |
| Amazon EC2 cloud-account integration setup (`configureAmazonEC2Integration...`, cross-account role helpers) | A distinct, multi-step cloud-onboarding flow layered on top of the generic Integrations service — deferred to a focused future pass rather than diluting this release's `integrations` type, which covers the generic create/update/delete/list surface. |

Verified against Bitdefender's own support documentation
(`bitdefender.com/business/support/en/77209-*`, one page per method) and cross-checked against
[`DainArtz/n8n-nodes-gravityzone`](https://github.com/DainArtz/n8n-nodes-gravityzone) as of 2026-08.

### Known limitations (honest, not stubs)

- **Response envelope shapes were not independently observed against a live tenant.** This app's
  research confirmed every method's *parameters* precisely from Bitdefender's own docs, but several
  methods' exact *response* shape — the list envelope key (`items` vs. a bare array vs. something else)
  and the id key a `create*` method returns (`id` vs. `accountId`/`groupId`/`packageId`/`integrationId`)
  — were not independently confirmed. `lib/gravityZoneCommon.ts`'s `unwrapListItems`/`readId` read
  several plausible shapes defensively rather than assuming one, the same "defensive dual-casing"
  treatment `apps/teleport` gives its own unverified Machine ID bot read-back casing.
- **`user-accounts`' `password` field is write-only.** GravityZone never returns a stored password, so
  drift detection cannot compare it and rollback cannot restore it. If set, the password is reset to
  that value on every deploy; leave it blank to let GravityZone generate one at creation and never
  manage it afterward.
- **`network-policy-assignments` cannot restore a target's specific prior policy on rollback.**
  GravityZone exposes no confirmed method to read "the current policy assignment for endpoint X"
  independent of `network.getManagedEndpointDetails`, whose response schema for policy information this
  app's research could not verify. Rollback resets declared targets to inherit from their parent
  container (`inheritFromAbove: true`) rather than guessing at an unverifiable prior `policyId`.
- **`policy-module-states` cannot restore prior module states on rollback.** `deploy` captures a
  best-effort snapshot of `policies.getPolicyDetails` before applying, but there is no confirmed mapping
  from that read-back shape to `setPolicyModulesState`'s write-side `settings` input — replaying it
  could silently send the wrong shape. Rollback reports the captured snapshot for manual restoration in
  the console instead of guessing.
- **`integrations`' `specifics` field may carry credential material** (e.g. a VMware service-account
  password) for integration types whose configuration includes one. It is authored and stored like any
  other declared field — the same treatment `apps/teleport` gives its GitHub connector's `client_secret`.

## Health check

Each configuration type's health check first confirms the API key is valid and GravityZone is reachable
(`general.getApiKeyDetails`), then confirms every item declared in the canvas is still present (or, for
`network-policy-assignments` and `policy-module-states`, still reachable/existing — see "Known
limitations" for why deeper field-level confirmation isn't possible for those two).

## References

- GravityZone Public API: <https://www.bitdefender.com/business/support/en/77212-125277-public-api.html>
- Per-method support docs cited throughout `lib/gravityZoneApi.ts` (e.g.
  <https://www.bitdefender.com/business/support/en/77209-135303-getpolicieslist.html>)
- Independent TypeScript reference client, built against this same API:
  <https://github.com/DainArtz/n8n-nodes-gravityzone>
