// healthCheck for zia-locations.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every Zscaler config type has in common. What is specific here is the
// second half of the check: every declared location must still exist in the
// tenant, matched by name, reported as `location:<name>`.

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
  label: 'zia-locations',
  handler: healthCheck,
  product: 'zia',
  probePath: '/zia/api/v1/status',
})

const LOCATION = item('HQ', {
  name: 'HQ London',
  country: 'UNITED_KINGDOM',
  tz: 'EUROPE_LONDON',
})

test('zia-locations healthCheck: passes when every declared location is present', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 7788, name: 'HQ London', country: 'UNITED_KINGDOM' }]),
  ])
  try {
    const result = await healthCheck(healthContext([LOCATION]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'location:HQ London')
    assert.ok(check, `expected a per-location check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('zia-locations healthCheck: fails when a declared location has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    activationStatus('ACTIVE'),
    ziaList([{ id: 7700, name: 'Branch Leeds' }]),
  ])
  try {
    const result = await healthCheck(healthContext([LOCATION]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'location:HQ London')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-locations healthCheck: does not look for locations when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every location would read as "does not exist" because nothing could be read.
  const { calls, restore } = recordFetch([TOKEN, { status: 500, body: { message: 'Service unavailable' } }])
  try {
    const result = await healthCheck(healthContext([LOCATION]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('location:')),
      false,
      'an unreadable tenant must not be reported as the location being absent',
    )
    assert.equal(calls.filter((c) => c.url.includes('/locations')).length, 0)
  } finally {
    restore()
  }
})
