// healthCheck for cloud-image-assessment-policies.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is that the per-policy check is not only about presence: a policy that
// exists but has been DISABLED in the console assesses nothing, so enablement is
// part of the check, reported as `policy:<name>`.

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
  label: 'cloud-image-assessment-policies',
  handler: healthCheck,
  probePath: '/container-security/entities/image-assessment-policies/v1',
  scopePattern: /image assessment policies scope/,
})

const POLICY = item('Registry gate', {
  name: 'Registry gate',
  action: 'prevent',
  enabled: true,
  rules: '[{"prop":"severity","value":"critical"}]',
})

const LIVE = { id: 'pol-live-1', name: 'Registry gate', is_enabled: true }

test('cloud-image-assessment-policies healthCheck: passes when every declared policy is present and enabled', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, entityPage([LIVE])])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'policy:Registry gate')
    assert.ok(check, `expected a per-policy check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies healthCheck: fails when a declared policy has been disabled in the console', async () => {
  // A disabled image assessment policy admits everything it was meant to gate,
  // so "present" is not enough for this check to pass.
  const { restore } = recordFetch([TOKEN, EMPTY, entityPage([{ ...LIVE, is_enabled: false }])])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'policy:Registry gate')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is disabled but should be enabled/)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies healthCheck: fails when a declared policy has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'policy:Registry gate')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies healthCheck: does not look for policies when the tenant is unreachable', async () => {
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
    assert.equal(calls.length, 2, 'a failed probe is followed by no per-policy read')
  } finally {
    restore()
  }
})

test('cloud-image-assessment-policies healthCheck: reports a failed per-policy lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-policy listing then 500s. That
  // is "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'policy:Registry gate')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /Failed to search policy/)
    assert.equal(
      /does not exist in the tenant/.test(String(check.message)),
      false,
      'a 500 became "does not exist"',
    )
  } finally {
    restore()
  }
})
