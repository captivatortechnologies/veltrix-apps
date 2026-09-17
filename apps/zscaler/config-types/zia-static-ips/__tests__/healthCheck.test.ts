// healthCheck for zia-static-ips.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared static IP must still exist in the
// tenant, matched by its IP address.

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
  label: 'zia-static-ips',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const STATIC_IP = item('Chicago egress', {
  ip_address: '203.0.113.10',
  comment: 'Chicago DC egress',
})

test('zia-static-ips healthCheck: passes when every declared static IP is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 4242, ipAddress: '203.0.113.10' }]),
  ])
  try {
    const result = await healthCheck(healthContext([STATIC_IP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'static-ip:203.0.113.10')
    assert.ok(check, `expected a per-static-IP check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-static-ips healthCheck: fails when a declared static IP has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 11, ipAddress: '198.51.100.7' }]),
  ])
  try {
    const result = await healthCheck(healthContext([STATIC_IP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'static-ip:203.0.113.10')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-static-ips healthCheck: does not look for static IPs when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every static IP would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([STATIC_IP]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('static-ip:')),
      false,
      'an unreadable tenant must not be reported as the static IP being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/staticIP')).length, 0)
  } finally {
    restore()
  }
})
