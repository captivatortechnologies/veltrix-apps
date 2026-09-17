// healthCheck for zia-dlp-engines.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared engine must still exist in the
// tenant, matched by name and reported as `engine:<name>`.

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
  label: 'zia-dlp-engines',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const ENGINE = item('Acme Secret Leakage', {
  name: 'Acme Secret Leakage',
  engine_expression: '((D63.S > 1))',
})

test('zia-dlp-engines healthCheck: passes when every declared engine is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 8801, name: 'Acme Secret Leakage', customDlpEngine: true }]),
  ])
  try {
    const result = await healthCheck(healthContext([ENGINE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'engine:Acme Secret Leakage')
    assert.ok(check, `expected a per-engine check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-dlp-engines healthCheck: fails when a declared engine has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 8899, name: 'Something Else', customDlpEngine: true }]),
  ])
  try {
    const result = await healthCheck(healthContext([ENGINE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'engine:Acme Secret Leakage')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-dlp-engines healthCheck: does not look for engines when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every engine would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([ENGINE]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('engine:')),
      false,
      'an unreadable tenant must not be reported as the engine being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/dlpEngines')).length, 0)
  } finally {
    restore()
  }
})
