// healthCheck for filevantage-scheduled-exclusions.
//
// THE SHARED CONTRACT CANNOT BE REGISTERED FOR THIS CONFIG TYPE. Every test in
// `registerHealthCheckContract` drives `healthContext([])`, and this is the only
// one of the 44 handlers that SHORT-CIRCUITS on an empty canvas: with nothing
// declared it returns healthy/100 from a `no_exclusions` check without opening a
// connection, so the contract's probe, 401, 403, 500 and token-failure tests all
// find zero calls. That divergence is reported.
//
// Rather than skip the coverage, the same eight assertions are reproduced below
// against a canvas with one declared exclusion — the only change being the
// context they run in. They are a local copy, defined in this file, because
// `falconContracts.ts` is shared and must not be edited.
//
// The transport reason this handler is shaped differently is real: BOTH the
// query and the get endpoints require a parent `policy_id`, so there is no
// tenant-wide probe to make until at least one exclusion names a policy.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  credentialWithoutClientId,
  emptyCredential,
  entityPage,
  forbidden,
  healthContext,
  idsPage,
  item,
  leaksSecret,
  notFound,
  recordFetch,
  routeFetch,
  serverError,
  tokenError,
  unauthorized,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'

const PROBE_PATH = '/filevantage/queries/policy-scheduled-exclusions/v1'
const CREDENTIAL_REFUSAL = /No Falcon API client available/

const EXCLUSION = item('Weekend patch window', {
  name: 'weekend-patch-window',
  policyId: 'fvp-1',
  timezone: 'Etc/UTC',
  scheduleStart: '2026-01-01T02:00:00Z',
  recurrence: 'weekly',
  weeklyDays: 'saturday',
  processes: 'C:\\Windows\\System32\\wuauclt.exe',
})

const LIVE_EXCLUSION = { id: 'fvse-live-1', name: 'weekend-patch-window', policy_id: 'fvp-1' }

// --- The shared contract, reproduced locally against a non-empty canvas -------

test('filevantage-scheduled-exclusions healthCheck: refuses without a credential, without calling Falcon', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await healthCheck(healthContext([EXCLUSION], { credential: null }))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 0)
    assert.equal(calls.length, 0, 'must not reach Falcon without a credential')
    const check = result.checks.find((c) => c.name === 'falcon_credential')
    assert.ok(check, `expected a "falcon_credential" check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, false)
    assert.match(String(check.message), CREDENTIAL_REFUSAL)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: refuses a credential with no secret, without calling Falcon', async () => {
  // A credential row exists but its secret fields are blank — OAuth2
  // client-credentials has nothing to present, so there is nothing to try.
  const { calls, restore } = recordFetch([])
  try {
    const result = await healthCheck(healthContext([EXCLUSION], { credential: emptyCredential() }))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 0)
    assert.equal(calls.length, 0, 'must not reach Falcon with an unusable credential')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: refuses a credential with no client id, without calling Falcon', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await healthCheck(
      healthContext([EXCLUSION], { credential: credentialWithoutClientId() }),
    )

    assert.equal(result.healthy, false)
    assert.equal(result.score, 0)
    assert.equal(calls.length, 0, 'must not reach Falcon without a client id')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: authenticates before probing, and reports healthy', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['fvse-live-1']), entityPage([LIVE_EXCLUSION])])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    const tenantCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenantCalls[0].method, 'GET')
    assert.ok(
      tenantCalls[0].url.includes(PROBE_PATH),
      `probe hit ${tenantCalls[0].url}, expected it to include ${PROBE_PATH}`,
    )
    assert.equal(
      new URL(tenantCalls[0].url).searchParams.get('policy_id'),
      'fvp-1',
      'the query endpoint has no tenant-wide form — it probes the first declared policy',
    )
    assert.equal(result.healthy, true)
    // The SDK contract: score is a PERCENTAGE, not a fraction.
    assert.equal(result.score, 100)

    const check = result.checks.find((c) => c.name === 'falcon_reachable')
    assert.ok(check, `expected a "falcon_reachable" check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(typeof check.latencyMs, 'number')
    assert.equal(leaksSecret(result), false, 'health result must not carry the token or client secret')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: reports a rejected bearer token rather than throwing', async () => {
  // FalconClient treats a 401 as an expired cached token and replays the request
  // after re-authenticating, so this needs URL routing, not a queue.
  const { calls, restore } = routeFetch([], unauthorized())
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 0)
    const check = result.checks.find((c) => c.name === 'falcon_reachable')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /401/)
    assert.equal(leaksSecret(result), false)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: reports a missing API scope rather than throwing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], forbidden())
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 0)
    const check = result.checks.find((c) => c.name === 'falcon_reachable')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /FileVantage: Read/)
    assert.equal(leaksSecret(result), false)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: surfaces the vendor’s error rather than throwing', async () => {
  const { calls, restore } = routeFetch(
    [{ url: /oauth2\/token/, respond: TOKEN }],
    serverError('internal server error'),
  )
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 0)
    const check = result.checks.find((c) => c.name === 'falcon_reachable')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
    assert.equal(leaksSecret(result), false)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: a rejected token exchange is reported, not thrown', async () => {
  const { calls, restore } = recordFetch([tokenError()])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 0)
    assert.equal(vendorCalls(calls).length, 0, 'no tenant call may follow a failed token exchange')
    assert.equal(leaksSecret(result), false, 'the failure message must not echo the client secret')
  } finally {
    restore()
  }
})

// --- Specific to this configuration type -------------------------------------

test('filevantage-scheduled-exclusions healthCheck: reports a parent policy that no longer exists', async () => {
  // The probe is scoped to a policy, so a 404 there is the policy being gone —
  // a known answer, and a much more useful message than a generic failure.
  const { restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], notFound())
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'falcon_reachable')
    assert.ok(check)
    assert.match(String(check.message), /FileVantage policy fvp-1 was not found/)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: fails when a declared exclusion is gone from its policy', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'scheduled-exclusion:weekend-patch-window')
    assert.ok(check, `expected a per-exclusion check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in policy fvp-1/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: does not look for exclusions when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every exclusion would read as "does not exist" because nothing could be read.
  const { restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(
      result.checks.some((c) => c.name.startsWith('scheduled-exclusion:')),
      false,
      'an unreadable tenant must not be reported as the exclusion being absent',
    )
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: reports a failed per-exclusion lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the policy listing then 500s. That is "I
  // could not look", and it must not read as the exclusion having been removed.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'scheduled-exclusion:weekend-patch-window')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.equal(
      /does not exist in policy/.test(String(check.message)),
      false,
      'an unreadable policy must not be reported as the exclusion being absent',
    )
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions healthCheck: makes no call at all when nothing is declared', async () => {
  // NOTE: what this handler RETURNS on this path is deliberately only partly
  // asserted. It short-circuits to healthy/100 without opening a connection,
  // which is why the shared health-check contract cannot be registered for this
  // config type — see the file header. Only the zero-call fact, which is
  // certainly right, and the check it names are asserted here.
  const { calls, restore } = recordFetch([])
  try {
    const result = await healthCheck(healthContext([]))

    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
    const check = result.checks.find((c) => c.name === 'no_exclusions')
    assert.ok(check, `expected a "no_exclusions" check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.match(String(check.message), /No scheduled exclusions declared/)
  } finally {
    restore()
  }
})
