// healthCheck for zia-gre-tunnels.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared tunnel must still exist in the
// tenant, matched by SOURCE IP — so the per-object check is named
// `tunnel:<source ip>`, not `tunnel:<name>`.

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
  label: 'zia-gre-tunnels',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const TUNNEL = item('HQ tunnel', {
  source_ip: '203.0.113.10',
  comment: 'desired comment',
})

test('zia-gre-tunnels healthCheck: passes when every declared source IP still has a tunnel', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 4411, sourceIp: '203.0.113.10', comment: 'desired comment' }]),
  ])
  try {
    const result = await healthCheck(healthContext([TUNNEL]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'tunnel:203.0.113.10')
    assert.ok(check, `expected a per-tunnel check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-gre-tunnels healthCheck: fails when a declared tunnel has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 4400, sourceIp: '198.51.100.1' }]),
  ])
  try {
    const result = await healthCheck(healthContext([TUNNEL]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'tunnel:203.0.113.10')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-gre-tunnels healthCheck: does not look for tunnels when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every tunnel would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([TUNNEL]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('tunnel:')),
      false,
      'an unreadable tenant must not be reported as the tunnel being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/greTunnels')).length, 0)
  } finally {
    restore()
  }
})
