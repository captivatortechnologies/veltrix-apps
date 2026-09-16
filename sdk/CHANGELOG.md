# Changelog

## 3.9.0 — 2026-09-16

### `HealthCheckResult.score` — the scale is 0–100, and now says so

`score` carried no contract at all: just `score: number`. The catalog split
roughly in half between a percentage and a fraction, and the fraction half was
wrong in a way nothing in the type could reveal. The platform stores the value
verbatim on the deployment and the console renders it as `<score>%`,
colour-banded at 80 and 50 — so an app returning `passed / checks.length`
reported a perfectly healthy deployment as **1%, in red**.

The field now documents 0–100 and carries the expression to use:

```ts
score: checks.length ? Math.round((passed / checks.length) * 100) : 0
```

Forty-five apps have been rescaled to match.

### `DriftResult.checked` — say "I could not look"

`DriftResult` was `{ hasDrift, diffs }` and nothing else, so a handler whose
vendor exposes no way to read a resource back had exactly one thing it could
return: `hasDrift: false`.

That is a POSITIVE assurance, and the platform acts on it. Its drift detector
treats "no drift" as in sync and marks any outstanding drift record for that
component resolved, with `resolvedAction: 'drift_cleared'`. So a handler that
could not look was telling the platform it had looked and found nothing — and
real drift recorded by other means was cleared on the next scheduled run.

Set `checked: false` when you genuinely cannot determine drift. The platform
then records nothing and clears nothing, leaving the component's drift state
untouched. Omit the field when you did check: absent means checked, so every
existing handler keeps its current meaning.

If your handler's comment says it "always reports no drift to avoid false
positives", it wants this field. Five handlers in the catalog were in exactly
that position and have been updated.

## 3.8.0 — 2026-09-16

Type and documentation corrections only — no runtime code changed. Both entries
describe platform behaviour that had already shipped and that this package was
still describing the old way. Nothing was removed from a type, so existing app
code continues to compile.

A minor rather than a patch because the contract these types describe changed
materially, and the notes are worth reading before the next app update.

### `AppRouteContext.resolveConnection` — `customerId` is no longer the tenant selector

The documentation said the call was "scoped to `customerId` (the tenant
boundary)", which invited an app to choose which tenant's connection it read.

The platform now takes the tenant from the **verified request context** and
ignores the value passed here. A value that disagrees with the request tenant is
logged and the call returns `null`, rather than being honoured silently, so a
genuine app bug stays visible instead of turning into a cross-tenant read.

The parameter is kept for backward compatibility — pass the tenant the route is
already serving. There is no supported way for an app to read another tenant's
credential.

### `PlatformDatabaseClient` now describes the scoped handle apps actually get

It claimed to be "the platform's Prisma client", with model delegates reachable
by name. It is a handle bound to the app and the current tenant:

- **Platform model delegates are absent** — not guarded, absent. `db.user`,
  `db.credential` and `db.$transaction` do not exist, so there is no handle
  through which to reach platform data. The one exception is a deprecated
  `db.appInstallation` shim pinned to this app and tenant, kept because every
  catalog app called it. Prefer `getInstallation()`.
- **`$queryRawUnsafe` and `$executeRawUnsafe` remain**, and every statement runs
  through an ownership check, with the app's own least-privilege Postgres role
  and a `search_path` pinned to the app's schema. "Unsafe" means what it means in
  Prisma: you are interpolating. Prefer the `query` / `execute` tagged templates
  in new code, which parameterise for you.
- **`resolveConnection` is present only when the manifest declares
  `credential:read`.** Without that declaration the platform does not attach it
  and the property is `undefined` at runtime, so check before calling.

The index signature is retained so existing app code still compiles, but anything
reached through it other than `appInstallation` is `undefined` at runtime. It
will be removed in the next major version.
