// healthCheck for host-groups.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared group must still resolve
// through the combined host-group read, reported as `host-group:<name>`.

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
  label: 'host-groups',
  handler: healthCheck,
  probePath: '/devices/queries/host-groups/v1',
  scopePattern: /Host groups: Read/,
})

const GROUP = item('Production servers', {
  name: 'prod-servers',
  groupType: 'dynamic',
  assignmentRule: "platform_name:'Windows'",
})

const LIVE_GROUP = { id: 'hg-live-1', name: 'prod-servers', group_type: 'dynamic' }

test('host-groups healthCheck: passes when every declared group is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, entityPage([LIVE_GROUP])])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'host-group:prod-servers')
    assert.ok(check, `expected a per-group check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('host-groups healthCheck: fails when a declared group has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'host-group:prod-servers')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('host-groups healthCheck: does not look for groups when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every group would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('host-group:')),
      false,
      'an unreadable tenant must not be reported as the group being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('/devices/combined/host-groups')).length,
      0,
      'no per-group lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('host-groups healthCheck: reports a failed per-group lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-group read then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'host-group:prod-servers')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})

test('host-groups healthCheck: scores each declared group independently', async () => {
  const SECOND = item('Staging servers', {
    name: 'stage-servers',
    groupType: 'dynamic',
    assignmentRule: "platform_name:'Windows'",
  })
  const { restore } = recordFetch([TOKEN, EMPTY, entityPage([LIVE_GROUP]), EMPTY])
  try {
    const result = await healthCheck(healthContext([GROUP, SECOND]))

    // Two of three checks passed — the score is a PERCENTAGE, not a fraction.
    assert.equal(result.score, 67)
    assert.equal(result.healthy, false)
    assert.equal(result.checks.find((c) => c.name === 'host-group:prod-servers')?.passed, true)
    assert.equal(result.checks.find((c) => c.name === 'host-group:stage-servers')?.passed, false)
  } finally {
    restore()
  }
})
