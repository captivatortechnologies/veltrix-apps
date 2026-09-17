// healthCheck for zpa-policy-rules.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling; the probe here is the ACCESS_POLICY policy set itself, which every
// ZPA tenant has. Specific to this config type: a rule is looked for WITHIN its
// policy set, and a set whose rules could not be listed is reported as "could
// not list" rather than as the rule being absent — the distinction an operator
// acts on differently.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  TOKEN,
  healthContext,
  item,
  ok,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerHealthCheckContract } from '../../../lib/__tests__/zscalerContracts'

const POLICY_SET_ID = '216196257331370370'

registerHealthCheckContract({
  label: 'zpa-policy-rules',
  handler: healthCheck,
  product: 'zpa',
  probePath: '/policySet/policyType/ACCESS_POLICY',
  probeResponse: ok({ id: POLICY_SET_ID, name: 'Global_Policy_Set' }),
})

const RULE = item('Allow Finance to ERP', {
  name: 'Allow Finance to ERP',
  policy_type: 'ACCESS_POLICY',
  action: 'ALLOW',
})

test('zpa-policy-rules healthCheck: passes when every declared rule is present in its policy set', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ok({ id: POLICY_SET_ID }),
    zpaList([{ id: '1', name: 'Allow Finance to ERP' }]),
  ])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'rule:ACCESS_POLICY/Allow Finance to ERP')
    assert.ok(check, `expected a per-rule check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zpa-policy-rules healthCheck: fails when a declared rule has been deleted from its policy set', async () => {
  const { restore } = recordFetch([TOKEN, ok({ id: POLICY_SET_ID }), zpaList([{ id: '1', name: 'Some Other Rule' }])])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'rule:ACCESS_POLICY/Allow Finance to ERP')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in ACCESS_POLICY/)
  } finally {
    restore()
  }
})

test('zpa-policy-rules healthCheck: a policy set it could not list is not reported as the rule being gone', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/policySet\/rules\/policyType\//, respond: serverError() },
    { url: /\/policySet\/policyType\//, respond: ok({ id: POLICY_SET_ID }) },
  ])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'rule:ACCESS_POLICY/Allow Finance to ERP')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /Could not list ACCESS_POLICY rules/)
    assert.equal(
      /does not exist/.test(String(check.message)),
      false,
      'a failed listing must not read as the rule having been deleted',
    )
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-policy-rules healthCheck: does not look for rules when the tenant is unreachable', async () => {
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { reason: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('rule:')),
      false,
      'an unreadable tenant must not be reported as the rule being absent',
    )
    assert.equal(calls.length, 2, 'the probe failed — nothing further should be read')
  } finally {
    restore()
  }
})
