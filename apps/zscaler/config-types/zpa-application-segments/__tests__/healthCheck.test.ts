// healthCheck for zpa-application-segments.
//
// The shared contract covers the refusals (including the ZPA customer id), the
// token-first probe and the error handling. What is specific here is the
// presence half: every declared application segment must still exist, matched by
// name — and an unreachable tenant must not be reported as the segment being
// gone, which for an application segment reads as "the app is down".

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  TOKEN,
  healthContext,
  item,
  recordFetch,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerHealthCheckContract } from '../../../lib/__tests__/zscalerContracts'

registerHealthCheckContract({
  label: 'zpa-application-segments',
  handler: healthCheck,
  product: 'zpa',
  probePath: '/application',
})

const SEGMENT = item('Corp Intranet', {
  name: 'Corp Intranet',
  domain_names: 'intranet.corp.example',
  segment_group_name: 'Corp Apps',
  server_group_names: 'DC1 Servers',
  tcp_port_ranges: '443',
  enabled: true,
})

const LIVE = { id: '216196257331370500', name: 'Corp Intranet' }

test('zpa-application-segments healthCheck: passes when every declared segment is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([LIVE]), zpaList([LIVE])])
  try {
    const result = await healthCheck(healthContext([SEGMENT]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'application:Corp Intranet')
    assert.ok(check, `expected a per-segment check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zpa-application-segments healthCheck: fails when a declared segment has been deleted in the tenant', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([LIVE]), zpaList([])])
  try {
    const result = await healthCheck(healthContext([SEGMENT]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'application:Corp Intranet')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('zpa-application-segments healthCheck: does not look for segments when the tenant is unreachable', async () => {
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { reason: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([SEGMENT]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('application:')),
      false,
      'an unreadable tenant must not be reported as the segment being absent',
    )
    assert.equal(calls.length, 2, 'the probe failed — nothing further should be read')
  } finally {
    restore()
  }
})
