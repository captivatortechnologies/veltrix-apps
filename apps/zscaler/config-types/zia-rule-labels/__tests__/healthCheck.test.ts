// healthCheck for zia-rule-labels.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared rule label must still exist in the
// tenant, matched by name.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  TOKEN,
  activationStatus,
  healthContext,
  item,
  recordFetch,
  writeCalls,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerHealthCheckContract } from '../../../lib/__tests__/zscalerContracts'

registerHealthCheckContract({
  label: 'zia-rule-labels',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const LABEL = item('Critical Egress', { name: 'Critical Egress', description: 'desired description' })

test('zia-rule-labels healthCheck: passes when every declared label is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 4001, name: 'Critical Egress', description: 'desired description' }]),
  ])
  try {
    const result = await healthCheck(healthContext([LABEL]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'label:Critical Egress')
    assert.ok(check, `expected a per-label check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-rule-labels healthCheck: fails when a declared label has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 4077, name: 'Something Else' }]),
  ])
  try {
    const result = await healthCheck(healthContext([LABEL]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'label:Critical Egress')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-rule-labels healthCheck: does not look for labels when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every label would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([LABEL]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('label:')),
      false,
      'an unreadable tenant must not be reported as the label being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/ruleLabels')).length, 0)
  } finally {
    restore()
  }
})
