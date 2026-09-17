// healthCheck for prevention-policies.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared policy must still resolve
// through the Prevention Policy combined query AND carry the declared
// enablement — a policy that exists but is switched off protects nobody, which
// is why presence alone does not pass.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  entityPage,
  healthContext,
  item,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerHealthCheckContract } from '../../../lib/__tests__/falconContracts'

registerHealthCheckContract({
  label: 'prevention-policies',
  handler: healthCheck,
  probePath: '/policy/queries/prevention/v1',
  scopePattern: /Prevention policies: Read/,
})

const POLICY = item('Windows prevention', {
  name: 'Corp Windows Prevention',
  platform: 'Windows',
  enabled: true,
  hostGroups: 'hg-workstations',
})

/** The live policy exactly as the canvas declares it. */
const LIVE = { id: 'pol-live-1', name: 'Corp Windows Prevention', platform_name: 'Windows', enabled: true }

test('prevention-policies healthCheck: passes when every declared policy is present and enabled', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, entityPage([LIVE])])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'policy:Corp Windows Prevention')
    assert.ok(check, `expected a per-policy check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('prevention-policies healthCheck: fails when a declared policy has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'policy:Corp Windows Prevention')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('prevention-policies healthCheck: fails a policy that exists but is switched off', async () => {
  // Present is not the same as in effect — a disabled prevention policy leaves
  // every host it targets on whatever policy ranks next.
  const { restore } = recordFetch([TOKEN, EMPTY, entityPage([{ ...LIVE, enabled: false }])])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'policy:Corp Windows Prevention')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is disabled but should be enabled/)
  } finally {
    restore()
  }
})

test('prevention-policies healthCheck: does not look for policies when the tenant is unreachable', async () => {
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
      calls.filter((c) => c.url.includes('/policy/combined/prevention/v1')).length,
      0,
      'no per-policy lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('prevention-policies healthCheck: reports a failed per-policy lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the combined query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'policy:Corp Windows Prevention')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
