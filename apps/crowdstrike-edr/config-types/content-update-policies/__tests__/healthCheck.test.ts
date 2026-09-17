// healthCheck for content-update-policies.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared policy must still resolve
// through the Content Update combined query AND carry the declared enablement —
// a policy that exists but is switched off leaves its hosts on whatever content
// update policy ranks next, which is not the ring schedule that was deployed.

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
  label: 'content-update-policies',
  handler: healthCheck,
  probePath: '/policy/queries/content-update/v1',
  scopePattern: /Content update policies: Read/,
})

const POLICY = item('Rapid response rings', {
  name: 'Corp Content Rings',
  enabled: true,
  hostGroups: 'hg-canary',
})

const LIVE = { id: 'pol-live-1', name: 'Corp Content Rings', enabled: true }

test('content-update-policies healthCheck: passes when every declared policy is present and enabled', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, entityPage([LIVE])])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'policy:Corp Content Rings')
    assert.ok(check, `expected a per-policy check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('content-update-policies healthCheck: looks a policy up by name alone — the family is not per-platform', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, entityPage([LIVE])])
  try {
    await healthCheck(healthContext([POLICY]))

    const find = calls.find((c) => c.url.includes('/policy/combined/content-update/v1'))
    assert.ok(find, 'no combined lookup was made')
    assert.equal(find.url.includes('platform_name'), false, 'content update policies have no platform')
  } finally {
    restore()
  }
})

test('content-update-policies healthCheck: fails when a declared policy has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'policy:Corp Content Rings')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('content-update-policies healthCheck: fails a policy that exists but is switched off', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, entityPage([{ ...LIVE, enabled: false }])])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'policy:Corp Content Rings')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is disabled but should be enabled/)
  } finally {
    restore()
  }
})

test('content-update-policies healthCheck: does not look for policies when the tenant is unreachable', async () => {
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
      calls.filter((c) => c.url.includes('/policy/combined/content-update/v1')).length,
      0,
      'no per-policy lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('content-update-policies healthCheck: reports a failed per-policy lookup as failed, not as absent', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'policy:Corp Content Rings')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
