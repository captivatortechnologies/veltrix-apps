// healthCheck for zia-network-service-groups.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared group must still exist in the tenant,
// matched by name. Note it reads ONLY /networkServiceGroups — unlike deploy it
// does not re-resolve the member services, so a group whose members were deleted
// still reads as healthy.

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
  label: 'zia-network-service-groups',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const GROUP = item('Vendor Access', { name: 'Vendor Access', services: 'Vendor SFTP' })

test('zia-network-service-groups healthCheck: passes when every declared group is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 5001, name: 'Vendor Access', services: [{ id: 7001, name: 'Vendor SFTP' }] }]),
  ])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'group:Vendor Access')
    assert.ok(check, `expected a per-group check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(
      calls.filter((c) => c.url.includes('/networkServices?')).length,
      0,
      'the presence check reads groups only — it never re-resolves member services',
    )
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-network-service-groups healthCheck: fails when a declared group has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 5077, name: 'Something Else' }]),
  ])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'group:Vendor Access')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-network-service-groups healthCheck: does not look for groups when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every group would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('group:')),
      false,
      'an unreadable tenant must not be reported as the group being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/networkServiceGroups')).length, 0)
  } finally {
    restore()
  }
})
