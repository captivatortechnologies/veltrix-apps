# Microsoft Entra ID improvement status

## Version 0.10.0 implementation

Implemented 22 additional configuration types (64 total), 40 administrative actions and 31 read-only reports. Added saved-connection Operations/Reports pages, expanded Conditional Access/authentication settings, direct licensing with inheritance protection, resource preflight/rollback/drift, provisioning/governance workflows and scoped readiness. Setup includes permissions, target IDs, managed JSON fields, asynchronous checks and irreversible effects.

Current verification: 2,596 tests pass; the browser check submits a confirmed action and renders a truncated report alongside all six setup tabs and 64 capability profiles. TypeScript and manifest validation pass. These are local checks, not live tenant acceptance.

The [current feature coverage matrix](FEATURE-COVERAGE.md) records implementation and remaining dependencies. Full Entra parity is still open, especially delegated workflows, credential generation/rotation and service-specific adapters. The earlier hardening record below describes version 0.9.0.


Version 0.9.0 implements the repository changes from the initial review. The app now reports unsupported capabilities, separates read access from write readiness, validates client code in CI, and checks managed configuration rather than treating endpoint reachability as deployment health. Live licensing, host integration, and tenant deployment checks remain release activities requiring a sandbox.

The [feature coverage audit](FEATURE-COVERAGE.md) separately records the much larger gap between these safety improvements and full Microsoft Entra functionality. Version 0.9.0 did not implement the missing Entra product features.

## Gap resolution

| Reviewed gap | Implemented change | Evidence and checks |
| --- | --- | --- |
| Unsupported Terms of Use management | Validation, deploy, rollback, and health reject app-only agreement management before network access. Drift returns unchecked. Overview/setup identify the limitation; existing agreement-ID references in Conditional Access remain supported. | Agreement handler gating tests and existing Conditional Access reference tests. Microsoft [agreement listing requirements](https://learn.microsoft.com/en-us/graph/api/termsofusecontainer-list-agreements?view=graph-rest-1.0). |
| Connection readiness too broad | Test verifies organization identity, then probes the configuration types selected in `readiness_features`. Denied, unknown, and unsupported features are reported separately; writes, conditional picker access and licensing remain unverified. | `lib/readiness.ts`, `handlers/testConnection.ts`, read-only probe, identity mismatch and permission-failure tests. |
| Ambiguous and incomplete names | Shared maps distinguish failed, capped, ambiguous and missing lookups. Cross-kind name collisions fail resolution. IDs bypass name lookups. Deploy/drift reconciliation refuses incomplete listings and duplicate requested names. | `config-types/lib/checkedNames.ts`, `nameMaps.ts`, `lib/reconciliation.ts`; collision, pagination and lookup-failure cases. |
| Unsafe mutation retries and pagination | Transport failures retry only reads; mutations return uncertain outcomes. URLs and nextLinks must use the selected cloud's Graph origin and v1.0 path; redirects are refused. Sovereign reference URLs are translated consistently. | Graph safety tests cover response loss after commit, read retry, foreign-origin nextLinks, malformed collections, throttling and cloud references. |
| Incomplete rollback reported as success | Restore PATCH 404 is failure; DELETE 404 remains idempotent. Undeletable attribute sets and unrecoverable provider secrets return unresolved rollback failures. Shared capability limits appear in setup/overview and pipeline validation warnings. | Rollback regressions, `lib/capabilityReview.ts`, and the shared capability registry. |
| Conditional Access enforcement review | Validation exposes effective state, targets and exclusions. Enabled all-user policies require a stored canvas acknowledgement. Deploy checks readable, disabled Security Defaults before writing and includes effective review data in deployment artifacts. | Policy validation/deploy tests cover acknowledgement, enabled/unreadable Security Defaults, and report-only defaults. Emergency-access functionality still requires an operational test. |
| Reachability mistaken for deployed health | Health keeps connectivity separate, verifies stored resource IDs when available, and uses each configuration type's drift comparison for managed fields. Missing, changed, failed and incomplete checks cannot yield full health. Empty desired configurations are explicitly connectivity only. | `lib/verification.ts`; per-type health contracts and deletion, changed-field, unchecked and exception cases. |
| Fragmented capability documentation | A registry covers every manifest type with read/write profiles, conditional reference/assignment permissions, licensing references, API version, app-only support and rollback limits. Setup, overview, readiness and README consume it. | Registry/manifest contract test and generated README table with `check:capabilities` in CI. |
| Missing client checks and unrelated read permission | Main TypeScript checking, including CI, includes client pages. Repository tools bundle and exercise all six setup tabs and overview and check generated docs. Automatic hooks for those two additional tools are preserved on the local `codex/entra-ci-workflow` branch pending GitHub workflow permission. Metadata/settings accept an existing resource permission via `?resource=groups`, with the platform still enforcing RBAC. Overview uses non-secret bundled capability data. | `tsconfig.json`, `scripts/check-entra-client.mjs`, server authorization tests, and the validation workflow. The seven original test type errors are fixed. |
| Fixed authentication and tenant targeting | Added encrypted-vault certificate assertions, optional host-broker tokens, cloud allowlists, token-field secrets and per-credential tenant/cloud overrides. Legacy fallbacks remain intact; malformed mappings fail closed. | Cryptographic signature/claim checks, per-cloud audience/authority tests, broker and tenant-isolation tests. [Migration and host integration instructions](AUTHENTICATION.md). |

## Local verification

Run from the repository root:

```powershell
npm --prefix apps/microsoft-entra-id run typecheck
npm --prefix apps/microsoft-entra-id run check:client
npm --prefix apps/microsoft-entra-id run check:capabilities
node scripts/validate-app.mjs apps/microsoft-entra-id
node scripts/test-apps.mjs microsoft-entra-id
node scripts/handler-coverage.mjs microsoft-entra-id
```

The regression suite retains handler behavior tests and adds failure-mode, tenant isolation, certificate signing, readiness, identity-verification and authorization checks. Tests for previously permitted unsafe behavior now assert the corrected outcomes. Obsolete agreement-write tests were replaced with tests proving the unsupported handlers cannot reach Graph; pure agreement body/schema tests remain.

Version 0.9.0 results: **2,314 tests passed**, zero failures or skips; backend and client typechecks passed; manifest validation passed with zero warnings; the client check exercised six setup tabs and 42 capability rows; generated capability documentation matched the registry. All 252 declared handlers have test coverage by the repository's presence-based coverage measure.

## Live release checks

A licensed Entra/Veltrix sandbox is required to verify actual consent, feature licensing, national-cloud API availability, host broker onboarding, platform approval rendering, and production styling. Local checks exercise the SDK fallback UI and fake Graph responses; they do not establish these live integration results.

1. Use a sandbox connection with deliberately limited application permissions. Confirm organization access can pass while selected features fail with useful diagnostics.
2. Deploy a report-only pilot policy, inspect sign-in results, test emergency access and rollback, then verify the enforcement acknowledgement and Security Defaults guard.
3. Delete or alter a managed sandbox object and confirm health/drift report the change. Exercise an interrupted mutation and partial rollback recovery.
4. Test the chosen certificate or broker connection and tenant overrides in each intended cloud. Confirm the host broker's cloud/tenant conventions before rollout.

Terms of Use delegated authentication would require a separate platform-supported user-token lifecycle. This release resolves the advertised-capability gap by blocking unsupported agreement management, rather than claiming an application permission can authorize it.
