// driftDetect for zia-locations — the shortest drift check in the app.
//
// The shared contract covers the invariants: drift never writes, a deleted
// location is critical drift, and a 500 is never reported as the location being
// gone. What is specific here is that there is nothing else: this handler is
// PRESENCE ONLY. It re-finds each declared location by name off a single
// listing and emits nothing but `missing`.
//
// NOT asserted here: `country`, `tz` and every key of the `location_json`
// escape hatch — `ipAddresses`, `authRequired`, `sslScanEnabled` and the rest.
// deploy WRITES all of them and driftDetect compares none of them, so a
// location whose authentication requirement was switched off by hand comes back
// in sync. Asserting that would bless it; it is in the report accompanying these
// tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  TOKEN,
  driftContext,
  item,
  recordFetch,
  resourceCalls,
  writeCalls,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const LOCATION = item('HQ', {
  name: 'HQ London',
  country: 'UNITED_KINGDOM',
  tz: 'EUROPE_LONDON',
  location_json: '{"ipAddresses":["203.0.113.10"],"authRequired":true}',
})

const BRANCH = item('Branch', { name: 'Branch Leeds', country: 'UNITED_KINGDOM' })

registerDriftContract({
  label: 'zia-locations',
  handler: driftDetect,
  product: 'zia',
  items: [LOCATION],
})

test('zia-locations driftDetect: reports no drift when the location is present', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([{ id: 7788, name: 'HQ London' }])])
  try {
    const result = await driftDetect(driftContext([LOCATION]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-locations driftDetect: reads one listing however many locations are declared', async () => {
  // Presence is resolved off a single GET; a per-location lookup would be N
  // round trips against a tenant that rate-limits.
  const { calls, restore } = recordFetch([TOKEN, ziaList([{ id: 7788, name: 'HQ London' }])])
  try {
    const result = await driftDetect(driftContext([LOCATION, BRANCH]))

    assert.equal(resourceCalls(calls).length, 1, `expected one listing, got ${resourceCalls(calls).length}`)
    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['Branch Leeds'],
      'only the location that is actually absent is reported',
    )
    assert.equal(result.diffs[0].severity, 'critical')
  } finally {
    restore()
  }
})
