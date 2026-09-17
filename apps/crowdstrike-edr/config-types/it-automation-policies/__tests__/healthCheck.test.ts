// healthCheck for it-automation-policies.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared policy must still resolve
// by name AND — when the live policy exposes it — match the declared enablement,
// reported as `policy:<name>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  entityPage,
  healthContext,
  idsPage,
  item,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerHealthCheckContract } from '../../../lib/__tests__/falconContracts'

registerHealthCheckContract({
  label: 'it-automation-policies',
  handler: healthCheck,
  probePath: '/it-automation/queries/policies/v1',
  scopePattern: /IT automation policies: Read/,
})

const POLICY = item('Windows automation', {
  name: 'win-it-automation',
  platform: 'Windows',
  enabled: true,
  description: 'Tier 1 automation policy',
})

/** Reachability probe, then the two-call entity-adapter lookup for one policy. */
const probeThenLookup = (live: Record<string, unknown> | null) =>
  live === null
    ? [TOKEN, EMPTY, EMPTY]
    : [TOKEN, EMPTY, idsPage([String(live.id)]), entityPage([live])]

test('it-automation-policies healthCheck: passes when every declared policy is present and enabled', async () => {
  const { calls, restore } = recordFetch(
    probeThenLookup({ id: 'pol-live-1', name: 'win-it-automation', is_enabled: true }),
  )
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'policy:win-it-automation')
    assert.ok(check, `expected a per-policy check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('it-automation-policies healthCheck: fails when a declared policy was disabled in the console', async () => {
  // A disabled IT automation policy stops script/Python/osquery execution on
  // every host it covers — "present" is not enough for this check to pass.
  const { restore } = recordFetch(
    probeThenLookup({ id: 'pol-live-1', name: 'win-it-automation', is_enabled: false }),
  )
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'policy:win-it-automation')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is disabled but should be enabled/)
  } finally {
    restore()
  }
})

test('it-automation-policies healthCheck: passes when the live policy does not expose its enablement', async () => {
  // An absent `is_enabled` is "the API did not say", not "disabled" — reporting
  // it as a mismatch would fail a healthy tenant on a field it never returned.
  const { restore } = recordFetch(probeThenLookup({ id: 'pol-live-1', name: 'win-it-automation' }))
  try {
    const result = await healthCheck(healthContext([POLICY]))

    const check = result.checks.find((c) => c.name === 'policy:win-it-automation')
    assert.ok(check)
    assert.equal(check.passed, true)
  } finally {
    restore()
  }
})

test('it-automation-policies healthCheck: fails when a declared policy has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch(probeThenLookup(null))
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50)
    const check = result.checks.find((c) => c.name === 'policy:win-it-automation')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('it-automation-policies healthCheck: does not look for policies when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every policy would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('policy:')),
      false,
      'an unreadable tenant must not be reported as the policy being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-policy lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('it-automation-policies healthCheck: reports a failed per-policy lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-policy query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'policy:win-it-automation')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
