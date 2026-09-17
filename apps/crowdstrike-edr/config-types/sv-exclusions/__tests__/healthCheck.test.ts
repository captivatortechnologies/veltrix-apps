// healthCheck for sv-exclusions.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared exclusion must still
// resolve through the Sensor Visibility Exclusions id query, reported as
// `sv-exclusion:<value>`.

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
  label: 'sv-exclusions',
  handler: healthCheck,
  probePath: '/policy/queries/sv-exclusions/v1',
  scopePattern: /Sensor Visibility Exclusions: Read/,
})

const EXCLUSION = item('Backup agent', {
  value: '/opt/backup/agent/**',
  appliedGlobally: true,
})

const LIVE = { id: 'sv-live-1', value: '/opt/backup/agent/**' }

test('sv-exclusions healthCheck: passes when every declared exclusion is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, idsPage(['sv-live-1']), entityPage([LIVE])])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'sv-exclusion:/opt/backup/agent/**')
    assert.ok(check, `expected a per-exclusion check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('sv-exclusions healthCheck: fails when a declared exclusion has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'sv-exclusion:/opt/backup/agent/**')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('sv-exclusions healthCheck: does not accept a near-match for the declared value', async () => {
  // The id query is an FQL match; the adapter pins the exact value client-side.
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['sv-other-1']),
    entityPage([{ id: 'sv-other-1', value: '/opt/backup/agent/logs/**' }]),
  ])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    const check = result.checks.find((c) => c.name === 'sv-exclusion:/opt/backup/agent/**')
    assert.ok(check)
    assert.equal(check.passed, false)
  } finally {
    restore()
  }
})

test('sv-exclusions healthCheck: does not look for exclusions when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every exclusion would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('sv-exclusion:')),
      false,
      'an unreadable tenant must not be reported as the exclusion being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-exclusion lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('sv-exclusions healthCheck: reports a failed per-exclusion lookup as failed, not as absent', async () => {
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([EXCLUSION]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'sv-exclusion:/opt/backup/agent/**')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
