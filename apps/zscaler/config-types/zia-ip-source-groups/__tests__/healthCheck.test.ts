// healthCheck for zia-ip-source-groups.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared source group must still exist in the
// tenant, matched by name, reported as `ipSourceGroup:<name>`.

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
  label: 'zia-ip-source-groups',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const GROUP = item('Branch sources', {
  name: 'Branch sources',
  ip_addresses: '203.0.113.0/24',
})

test('zia-ip-source-groups healthCheck: passes when every declared group is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 5511, name: 'Branch sources', ipAddresses: ['203.0.113.0/24'] }]),
  ])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'ipSourceGroup:Branch sources')
    assert.ok(check, `expected a per-group check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-ip-source-groups healthCheck: fails when a declared group has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 5500, name: 'Something Else' }]),
  ])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'ipSourceGroup:Branch sources')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-ip-source-groups healthCheck: does not look for groups when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every group would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('ipSourceGroup:')),
      false,
      'an unreadable tenant must not be reported as the group being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/ipSourceGroups')).length, 0)
  } finally {
    restore()
  }
})
