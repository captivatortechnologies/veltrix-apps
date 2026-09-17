// driftDetect for zpa-service-edge-groups.
//
// The shared contract covers the invariants. What is specific here is the
// comparison — description, enabled and location — and ZPA's own attribution
// shape, where the modifier is a bare admin id in `modifiedBy` plus an
// epoch-second STRING in `modifiedTime`, rather than ZIA's id/name pair.
//
// NOTE: the rest of what deploy writes (latitude, longitude, countryCode,
// versionProfileId, upgradeDay, upgradeTimeInSecs) is NOT compared by this
// handler, so no test here asserts anything about those fields — see the
// report. Asserting the current behaviour would bless it.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  item,
  recordFetch,
  settingsWithoutCustomerId,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const EDGE_GROUP = item('San Jose Edges', {
  name: 'San Jose Edges',
  description: 'desired description',
  enabled: true,
  location: 'San Jose, CA, USA',
  latitude: '37.3382',
  longitude: '-121.8863',
  country_code: 'US',
  version_profile_id: '2',
  upgrade_day: 'TUESDAY',
  upgrade_time_in_secs: '3600',
})

registerDriftContract({
  label: 'zpa-service-edge-groups',
  handler: driftDetect,
  product: 'zpa',
  items: [EDGE_GROUP],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: '216196257331370400',
  name: 'San Jose Edges',
  description: 'desired description',
  enabled: true,
  location: 'San Jose, CA, USA',
  latitude: '37.3382',
  longitude: '-121.8863',
  countryCode: 'US',
  versionProfileId: '2',
  upgradeDay: 'TUESDAY',
  upgradeTimeInSecs: '3600',
  ...over,
})

test('zpa-service-edge-groups driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([live()])])
  try {
    const result = await driftDetect(driftContext([EDGE_GROUP]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups driftDetect: reports a group rehomed to another location', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ location: 'Santa Clara, CA, USA' })])])
  try {
    const result = await driftDetect(driftContext([EDGE_GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'San Jose Edges.location')
    assert.ok(diff, `expected a location diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'San Jose, CA, USA')
    assert.equal(diff.actual, 'Santa Clara, CA, USA')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups driftDetect: reports a description edited in the portal', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ description: 'edited by hand' })])])
  try {
    const result = await driftDetect(driftContext([EDGE_GROUP]))

    const diff = result.diffs.find((d) => d.field === 'San Jose Edges.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited by hand')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups driftDetect: reports a group someone disabled by hand', async () => {
  // Disabling the group takes its Private Service Edges out of service, so this
  // is the diff an operator most needs to see.
  const { restore } = recordFetch([TOKEN, zpaList([live({ enabled: false })])])
  try {
    const result = await driftDetect(driftContext([EDGE_GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'San Jose Edges.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups driftDetect: attributes a manual change to the ZPA admin id that made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: '216196257331370351', modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([EDGE_GROUP]))

    const diff = result.diffs.find((d) => d.field === 'San Jose Edges.enabled') as
      | { actor?: { id?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.id, '216196257331370351')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups driftDetect: does not attribute our own deploy as a manual change', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: CLIENT_ID, modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([EDGE_GROUP]))

    const diff = result.diffs.find((d) => d.field === 'San Jose Edges.enabled') as
      | { actor?: { id?: string } }
      | undefined
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'a change recorded under our own OneAPI client is not a manual change')
  } finally {
    restore()
  }
})

test('zpa-service-edge-groups driftDetect: makes no call without a ZPA customer id', async () => {
  // NOTE: what this returns on this path is deliberately not asserted — see the
  // report. It cannot address the tenant at all, yet answers like a clean check.
  const { calls, restore } = recordFetch([])
  try {
    await driftDetect(driftContext([EDGE_GROUP], { settings: settingsWithoutCustomerId() }))

    assert.equal(calls.length, 0, 'ZPA is unaddressable without a customer id')
  } finally {
    restore()
  }
})
