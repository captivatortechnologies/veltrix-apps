// healthCheck for zia-file-type-rules.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half: every declared file type rule must still exist in the tenant,
// matched by name and reported as a `rule:<name>` check.

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
  label: 'zia-file-type-rules',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const RULE = item('Caution On Spreadsheets', {
  name: 'Caution On Spreadsheets',
  order: 12,
  state: 'DISABLED',
  action: 'CAUTION',
})

test('zia-file-type-rules healthCheck: passes when every declared rule is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 505, name: 'Caution On Spreadsheets', order: 12 }]),
  ])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'rule:Caution On Spreadsheets')
    assert.ok(check, `expected a per-rule check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-file-type-rules healthCheck: fails when a declared rule has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 1, name: 'Something Else' }]),
  ])
  try {
    const result = await healthCheck(healthContext([RULE]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'rule:Caution On Spreadsheets')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-file-type-rules healthCheck: does not look for rules when the tenant is unreachable', async () => {
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
    assert.equal(calls.filter((c) => c.url.includes('/fileTypeRules')).length, 0)
  } finally {
    restore()
  }
})

// NOT asserted: the probe succeeding and the rule LISTING then failing. The
// listing helper throws and healthCheck does not catch it, so the handler
// rejects instead of returning a failed result. Asserting the rejection would
// bless it — reported instead.
