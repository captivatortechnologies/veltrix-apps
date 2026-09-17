// healthCheck for zpa-service-edge-groups.
//
// The shared contract covers the refusals (including the ZPA customer id), the
// token-first probe and the error handling. What is specific here is the
// presence half: every declared service edge group must still exist, matched by
// name — neither its location nor its upgrade window is re-checked.

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
  label: 'zpa-service-edge-groups',
  handler: healthCheck,
  product: 'zpa',
  probePath: '/serviceEdgeGroup',
})

const EDGE_GROUP = item('San Jose Edges', {
  name: 'San Jose Edges',
  enabled: true,
  location: 'San Jose, CA, USA',
  latitude: '37.3382',
  longitude: '-121.8863',
})

test('zpa-service-edge-groups healthCheck: passes when every declared group is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList([{ id: '1', name: 'San Jose Edges' }]),
    zpaList([{ id: '1', name: 'San Jose Edges' }]),
  ])
  try {
    const result = await healthCheck(healthContext([EDGE_GROUP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'serviceEdgeGroup:San Jose Edges')
    assert.ok(check, `expected a per-group check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups healthCheck: fails when a declared group has been deleted in the tenant', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([{ id: '1', name: 'San Jose Edges' }]), zpaList([])])
  try {
    const result = await healthCheck(healthContext([EDGE_GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'serviceEdgeGroup:San Jose Edges')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups healthCheck: does not look for groups when the tenant is unreachable', async () => {
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { reason: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([EDGE_GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('serviceEdgeGroup:')),
      false,
      'an unreadable tenant must not be reported as the group being absent',
    )
    assert.equal(calls.length, 2, 'the probe failed — nothing further should be read')
  } finally {
    restore()
  }
})
