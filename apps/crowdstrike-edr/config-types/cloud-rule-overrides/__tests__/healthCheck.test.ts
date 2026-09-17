// healthCheck for cloud-rule-overrides.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. Two things are
// specific here: the rule-overrides collection has no queries endpoint, so
// reachability is probed against the sibling cloud-policies RULES query, and the
// per-object check reads each override directly by its rule id, reported as
// `rule-override:<ruleId>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  entityPage,
  healthContext,
  item,
  notFound,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerHealthCheckContract } from '../../../lib/__tests__/falconContracts'

registerHealthCheckContract({
  label: 'cloud-rule-overrides',
  handler: healthCheck,
  probePath: '/cloud-policies/queries/rules/v1',
  scopePattern: /Cloud security rules: Read/,
})

const OVERRIDE = item('Public bucket exception', {
  ruleId: 'rule-1234',
  overrideType: 'exception',
  crn: 'crn:aws:111122223333',
})

const LIVE = { id: 'ov-live-1', rule_id: 'rule-1234', crn: 'crn:aws:111122223333' }

test('cloud-rule-overrides healthCheck: passes when every declared override is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, entityPage([LIVE])])
  try {
    const result = await healthCheck(healthContext([OVERRIDE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'rule-override:rule-1234')
    assert.ok(check, `expected a per-override check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides healthCheck: fails when a declared override has been removed in the tenant', async () => {
  const { calls, restore } = recordFetch([TOKEN, EMPTY, EMPTY])
  try {
    const result = await healthCheck(healthContext([OVERRIDE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'rule-override:rule-1234')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is not present in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides healthCheck: reports a 404 as the override being absent', async () => {
  // "Gone" is a known answer, unlike a 5xx, so it belongs in the absent branch
  // rather than surfacing as an unreadable tenant.
  const { restore } = recordFetch([TOKEN, EMPTY, notFound()])
  try {
    const result = await healthCheck(healthContext([OVERRIDE]))

    const check = result.checks.find((c) => c.name === 'rule-override:rule-1234')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is not present in the tenant/)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides healthCheck: does not accept an override scoped to another cloud account', async () => {
  // The override exists for the rule, but not for the account this canvas
  // declared — the rule is still enforced where the exception was meant to apply.
  const { restore } = recordFetch([
    TOKEN,
    EMPTY,
    entityPage([{ ...LIVE, crn: 'crn:aws:999988887777' }]),
  ])
  try {
    const result = await healthCheck(healthContext([OVERRIDE]))

    const check = result.checks.find((c) => c.name === 'rule-override:rule-1234')
    assert.ok(check)
    assert.equal(check.passed, false)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides healthCheck: does not look for overrides when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every override would read as absent because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([OVERRIDE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('rule-override:')),
      false,
      'an unreadable tenant must not be reported as the override being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('rule-overrides')).length,
      0,
      'no per-override read may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('cloud-rule-overrides healthCheck: reports a failed per-override read as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-override read then 500s. That is
  // "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([OVERRIDE]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'rule-override:rule-1234')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
