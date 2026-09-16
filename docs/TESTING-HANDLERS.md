# Testing pipeline handlers

Every configuration type ships six handlers. Only one of them is local logic:

| Handler | What it does | Where it runs |
|---|---|---|
| `validate` | checks the canvas against the vendor's constraints | locally, no network |
| `deploy` | creates or updates the resource | **against the customer's vendor** |
| `rollback` | restores prior state | **against the customer's vendor** |
| `healthCheck` | probes reachability | **against the customer's vendor** |
| `driftDetect` | compares live state to desired | **against the customer's vendor** |
| `getStatus` | reports deployment state | from platform records |

For a long time the catalog tested only `validate`. Every configuration type had
a `__tests__` folder, which reads as covered, and the four handlers that reach a
vendor and change a customer's configuration sat between 0.1% and 15%.

Check where you stand:

```
node scripts/handler-coverage.mjs <app-id>
```

CI enforces that the catalog-wide number does not regress.

## The pattern

Handlers reach their vendor through global `fetch`, so stubbing it drives a real
handler end to end — its request sequence, its bodies, its error handling, the
rollback state it records. No module mocking, no new dependency, no change to
handler source.

The harness is about twenty lines:

```ts
function recordFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body: string }> = []
  const queue = [...responses]
  const original = globalThis.fetch

  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    })
    const next = queue.shift() ?? { status: 200, body: {} }
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(next.body ?? {}),
    }
  }) as unknown as typeof globalThis.fetch

  return { calls, restore: () => { globalThis.fetch = original } }
}
```

Always restore in a `finally`, or one test's stub leaks into the next.

The worked example is
[`apps/crowdstrike-edr/config-types/cloud-groups/__tests__/deploy.test.ts`](../apps/crowdstrike-edr/config-types/cloud-groups/__tests__/deploy.test.ts).

## Running them

From the repository root, not from inside an app:

```
node scripts/test-apps.mjs <app-id>
```

Handlers use extensionless imports, so plain `node --test` will not resolve
them. The script bundles each test with esbuild — the same bundler that packages
a handler for the platform — and hands the result to `node:test`.

## What to test

The three failures worth targeting first are in
[HANDLER-CORRECTNESS.md](HANDLER-CORRECTNESS.md) — guards that fail open,
rollback state recorded too late, and drift claiming a conclusion it did not
reach. Those are where the catalog's real defects have been.


Assert the things that actually break in production rather than restating the
happy path:

- **Refuses before touching the vendor** when no credential is configured. Assert
  zero calls were made, not just that the result failed.
- **Authenticates before its first real request**, where the vendor needs a
  token. Assert the token never appears in a result message or error.
- **Creates what does not exist, updates what does.** These are different code
  paths and the second is the one that silently overwrites.
- **Returns a failed result rather than throwing** when the vendor rejects. A
  handler that throws surfaces as an opaque pipeline crash instead of a message
  the operator can act on.
- **Rollback restores prior state**, and does something sensible when there is
  none to restore.
- **Deploy records the rollback state** it is supposed to record. Rollback cannot
  work if deploy never wrote the state down, and nothing else catches that.

## Two things that will bite you

**Your fixture is wrong before the handler is.** The first version of the worked
example had two failures, both caused by the test's own canvas shape rather than
the code — the handler read `section.fields` and the fixture supplied
`section.items`. Read the handler's extractor before building the fixture, and
when a test fails, work out which side is wrong before changing either.

**Minified handlers are normal here.** Several apps ship handlers as a single
line with no spaces after `import`/`from`. That is the release build, not a
defect. Read them anyway.

## What not to do

- Do not change handler source to make a test pass. If you find a real bug,
  report it separately — a test written around a bug documents the bug as
  correct.
- Do not weaken an assertion to get green.
- Do not skip a test rather than fix it.
