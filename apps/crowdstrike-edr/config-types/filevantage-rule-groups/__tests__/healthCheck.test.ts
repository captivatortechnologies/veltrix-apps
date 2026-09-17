// healthCheck for filevantage-rule-groups.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is that presence alone is not health: a group of the wrong type cannot
// carry the rules declared for it, and a group missing a declared rule leaves
// that path unmonitored while the configuration still reads as deployed.

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
  label: 'filevantage-rule-groups',
  handler: healthCheck,
  probePath: '/filevantage/queries/rule-groups/v1',
  scopePattern: /Falcon FileVantage: Read/,
})

const WATCHED_PATH = 'C:\\Windows\\System32'

const GROUP = item('System binary monitoring', {
  name: 'veltrix-fim-system',
  type: 'WindowsFiles',
  rules: JSON.stringify([
    { path: WATCHED_PATH, severity: 'High', depth: 'ANY', description: 'System binaries' },
  ]),
})

const LIVE_GROUP = {
  id: 'fvrg-live-1',
  name: 'veltrix-fim-system',
  type: 'WindowsFiles',
  assigned_rules: [{ id: 'fvr-1' }],
}

const LIVE_RULE = { id: 'fvr-1', path: WATCHED_PATH, severity: 'High', depth: 'ANY' }

test('filevantage-rule-groups healthCheck: passes when the group is present with every declared rule', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['fvrg-live-1']),
    entityPage([LIVE_GROUP]),
    entityPage([LIVE_RULE]),
  ])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'rule-group:veltrix-fim-system')
    assert.ok(check, `expected a per-group check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('filevantage-rule-groups healthCheck: fails when the group has been deleted in the tenant', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'rule-group:veltrix-fim-system')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups healthCheck: fails when the live group is of a different type', async () => {
  // Type is immutable, so a group under this name with another type cannot hold
  // the declared rules — the configuration is not deployed, whatever is there.
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['fvrg-live-1']),
    entityPage([{ ...LIVE_GROUP, type: 'WindowsRegistry' }]),
  ])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'rule-group:veltrix-fim-system')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is type WindowsRegistry but should be WindowsFiles/)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups healthCheck: fails when a declared rule is missing from the group', async () => {
  // The group exists, so a presence-only check passes. The path it was deployed
  // to watch is not being watched.
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['fvrg-live-1']),
    entityPage([{ ...LIVE_GROUP, assigned_rules: [] }]),
  ])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'rule-group:veltrix-fim-system')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /missing declared rule\(s\)/)
  } finally {
    restore()
  }
})

test('filevantage-rule-groups healthCheck: does not look for groups when the tenant is unreachable', async () => {
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
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-group lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('filevantage-rule-groups healthCheck: reports an unreadable rule list as failed, not as missing rules', async () => {
  // The group read fine and the rules read 500d. Falling through to an empty
  // list would report every declared path as missing from a healthy group.
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['fvrg-live-1']),
    entityPage([LIVE_GROUP]),
    serverError(),
  ])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'rule-group:veltrix-fim-system')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.equal(
      /missing declared rule/.test(String(check.message)),
      false,
      'an unreadable rule list must not be reported as the rules being gone',
    )
  } finally {
    restore()
  }
})
