// healthCheck for zpa-app-connector-groups.
//
// The shared contract covers the refusals (including the ZPA customer id), the
// token-first probe and the error handling. What is specific here is the
// presence half: every declared App Connector group must still exist, matched by
// name — and an unreachable tenant must not be reported as the group being gone.

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
  label: 'zpa-app-connector-groups',
  handler: healthCheck,
  product: 'zpa',
  probePath: '/appConnectorGroup',
})

const GROUP = item('San Jose Connectors', {
  name: 'San Jose Connectors',
  location: 'San Jose, CA, USA',
  latitude: '37.3382',
  longitude: '-121.8863',
  enabled: true,
})

const LIVE = { id: '216196257331370400', name: 'San Jose Connectors' }

test('zpa-app-connector-groups healthCheck: passes when every declared group is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([LIVE]), zpaList([LIVE])])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'appConnectorGroup:San Jose Connectors')
    assert.ok(check, `expected a per-group check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups healthCheck: fails when a declared group has been deleted in the tenant', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([LIVE]), zpaList([])])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'appConnectorGroup:San Jose Connectors')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups healthCheck: does not look for groups when the tenant is unreachable', async () => {
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { reason: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([GROUP]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('appConnectorGroup:')),
      false,
      'an unreadable tenant must not be reported as the group being absent',
    )
    assert.equal(calls.length, 2, 'the probe failed — nothing further should be read')
  } finally {
    restore()
  }
})
