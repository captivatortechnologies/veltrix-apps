// healthCheck for filevantage-policies.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is that presence alone is not health: a FileVantage policy that exists
// but is disabled monitors no files at all, so the declared enablement is part
// of the check.

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
  label: 'filevantage-policies',
  handler: healthCheck,
  probePath: '/filevantage/queries/policies/v1',
  scopePattern: /Falcon FileVantage: Read/,
})

const POLICY = item('Windows FIM policy', {
  name: 'veltrix-fim-windows',
  platform: 'Windows',
  enabled: true,
  hostGroups: 'hg-prod',
  ruleGroups: 'rg-system',
})

const LIVE_POLICY = {
  id: 'fvp-live-1',
  name: 'veltrix-fim-windows',
  platform: 'Windows',
  enabled: true,
  host_groups: ['hg-prod'],
  rule_groups: ['rg-system'],
}

test('filevantage-policies healthCheck: passes when the policy is present and enabled', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['fvp-live-1']),
    entityPage([LIVE_POLICY]),
  ])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'policy:veltrix-fim-windows')
    assert.ok(check, `expected a per-policy check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('filevantage-policies healthCheck: fails when the policy has been deleted in the tenant', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'policy:veltrix-fim-windows')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('filevantage-policies healthCheck: fails when the policy was disabled in the console', async () => {
  // A disabled FileVantage policy still exists and still looks deployed. None of
  // the paths it names are being watched.
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['fvp-live-1']),
    entityPage([{ ...LIVE_POLICY, enabled: false }]),
  ])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'policy:veltrix-fim-windows')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is disabled but should be enabled/)
  } finally {
    restore()
  }
})

test('filevantage-policies healthCheck: does not look for policies when the tenant is unreachable', async () => {
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

test('filevantage-policies healthCheck: reports a failed per-policy lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the name query then 500s. That is "I
  // could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'policy:veltrix-fim-windows')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.equal(
      /does not exist in the tenant/.test(String(check.message)),
      false,
      'an unreadable tenant must not be reported as the policy being absent',
    )
  } finally {
    restore()
  }
})

test('filevantage-policies healthCheck: fails a lookup whose candidate hydration could not be read', async () => {
  // The id query answered, the entity read then 500d. Falling through to "does
  // not exist" would report a live FIM policy as deleted.
  const { restore } = recordFetch([TOKEN, EMPTY, idsPage(['fvp-live-1']), serverError()])
  try {
    const result = await healthCheck(healthContext([POLICY]))

    const check = result.checks.find((c) => c.name === 'policy:veltrix-fim-windows')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.equal(
      /does not exist in the tenant/.test(String(check.message)),
      false,
      'an unreadable policy must not be reported as absent',
    )
  } finally {
    restore()
  }
})
