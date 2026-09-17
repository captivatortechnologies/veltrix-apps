// healthCheck for ngsiem-correlation-rules.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared rule must still resolve
// through the Correlation Rules id query, reported as `correlation-rule:<name>`.

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
  label: 'ngsiem-correlation-rules',
  handler: healthCheck,
  probePath: '/correlation-rules/queries/rules/v1',
  scopePattern: /Correlation Rules: Read/,
})

const RULE = item('LSASS credential dumping', {
  name: 'lsass-credential-dumping',
  search: '#event_simpleName=ProcessRollup2',
  severity: 'high',
  frequency: '15m',
  status: 'active',
})

test('ngsiem-correlation-rules healthCheck: passes when every declared rule is present', async () => {
  // The per-rule lookup is the adapter's two calls: id query, then entity get.
  const { calls, restore } = recordFetch([
    TOKEN,
    EMPTY,
    idsPage(['rule-live-1']),
    entityPage([{ id: 'rule-live-1', name: 'lsass-credential-dumping' }]),
  ])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'correlation-rule:lsass-credential-dumping')
    assert.ok(check, `expected a per-rule check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules healthCheck: fails when a declared rule has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'correlation-rule:lsass-credential-dumping')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules healthCheck: does not look for rules when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every rule would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('correlation-rule:')),
      false,
      'an unreadable tenant must not be reported as the rule being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-rule lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules healthCheck: reports a failed per-rule lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-rule query then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'correlation-rule:lsass-credential-dumping')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
    assert.equal(
      /does not exist/.test(String(check.message)),
      false,
      'a 500 is "I could not look", not "the rule is gone"',
    )
  } finally {
    restore()
  }
})
