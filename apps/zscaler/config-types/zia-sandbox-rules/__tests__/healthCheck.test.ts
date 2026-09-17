// healthCheck for zia-sandbox-rules.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared sandbox rule must still exist in the
// tenant, matched by name. Presence is all it checks — a rule still present but
// flipped to DISABLED, or with its Sandbox action changed, reads as healthy.

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
  label: 'zia-sandbox-rules',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const RULE = item('Block Malicious Files', { name: 'Block Malicious Files', order: '2', state: 'ENABLED' })

test('zia-sandbox-rules healthCheck: passes when every declared rule is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 9001, name: 'Block Malicious Files', order: 2, state: 'ENABLED' }]),
  ])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'rule:Block Malicious Files')
    assert.ok(check, `expected a per-rule check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-sandbox-rules healthCheck: fails when a declared rule has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 9000, name: 'Default Sandbox Rule', defaultRule: true }]),
  ])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'rule:Block Malicious Files')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-sandbox-rules healthCheck: does not look for rules when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every rule would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('rule:')),
      false,
      'an unreadable tenant must not be reported as the rule being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/sandboxRules')).length, 0)
  } finally {
    restore()
  }
})
