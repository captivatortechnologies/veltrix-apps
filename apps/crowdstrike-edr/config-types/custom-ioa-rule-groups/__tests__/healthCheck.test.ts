// healthCheck for custom-ioa-rule-groups.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is that presence alone is not health: a group that exists but is disabled
// detects nothing, and a group missing a declared rule leaves that behaviour
// unwatched — both must fail the check.

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
  label: 'custom-ioa-rule-groups',
  handler: healthCheck,
  probePath: '/ioarules/queries/rule-groups/v1',
  scopePattern: /Custom IOA rules: Read/,
})

const DECLARED_RULE = {
  name: 'Encoded PowerShell',
  ruletypeId: '5',
  dispositionId: 30,
  patternSeverity: 'critical',
  fieldValues: [],
  enabled: true,
  description: 'Block encoded PowerShell',
}

const GROUP = item('Encoded PowerShell detection', {
  name: 'veltrix-ioa-windows',
  platform: 'windows',
  enabled: true,
  rules: JSON.stringify([DECLARED_RULE]),
})

const LIVE_GROUP = {
  id: 'rg-live-1',
  name: 'veltrix-ioa-windows',
  platform: 'windows',
  enabled: true,
  version: 3,
  rules: [{ instance_id: 'ri-1', name: 'Encoded PowerShell', enabled: true }],
}

test('custom-ioa-rule-groups healthCheck: passes when the group is present, enabled and complete', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, entityPage([LIVE_GROUP])])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'rule-group:veltrix-ioa-windows')
    assert.ok(check, `expected a per-group check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups healthCheck: fails when the group has been deleted in the tenant', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'rule-group:veltrix-ioa-windows')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups healthCheck: fails when the group was disabled in the console', async () => {
  // A disabled group still exists and still looks deployed. It detects nothing.
  const { restore } = recordFetch([TOKEN, EMPTY, entityPage([{ ...LIVE_GROUP, enabled: false }])])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'rule-group:veltrix-ioa-windows')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is disabled but should be enabled/)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups healthCheck: fails when a declared rule is missing from the group', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, entityPage([{ ...LIVE_GROUP, rules: [] }])])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'rule-group:veltrix-ioa-windows')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /missing declared rule\(s\): Encoded PowerShell/)
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups healthCheck: does not look for groups when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every group would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('rule-group:')),
      false,
      'an unreadable tenant must not be reported as the group being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('/ioarules/combined/rule-groups')).length,
      0,
      'no per-group lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('custom-ioa-rule-groups healthCheck: reports a failed per-group lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-group read then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'rule-group:veltrix-ioa-windows')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
