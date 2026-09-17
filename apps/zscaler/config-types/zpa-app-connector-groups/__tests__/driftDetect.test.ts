// driftDetect for zpa-app-connector-groups.
//
// The shared contract covers the invariants. Specific here is the comparison the
// handler actually performs — description, enabled and location — and ZPA's own
// attribution shape, where the modifier is a bare admin id in `modifiedBy` and
// the timestamp an epoch-second STRING, rather than ZIA's id/name pair.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  item,
  leaksSecret,
  recordFetch,
  settingsWithoutCustomerId,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const GROUP = item('San Jose Connectors', {
  name: 'San Jose Connectors',
  description: 'desired description',
  enabled: true,
  location: 'San Jose, CA, USA',
  latitude: '37.3382',
  longitude: '-121.8863',
  dns_query_type: 'IPV4',
  version_profile_id: '2',
})

registerDriftContract({
  label: 'zpa-app-connector-groups',
  handler: driftDetect,
  product: 'zpa',
  items: [GROUP],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: '216196257331370400',
  name: 'San Jose Connectors',
  description: 'desired description',
  enabled: true,
  location: 'San Jose, CA, USA',
  ...over,
})

// NOTE: latitude, longitude, countryCode, dnsQueryType, versionProfileId and
// cityCountry are all WRITTEN by deploy and never compared here, so no test
// asserts them — see the report.

test('zpa-app-connector-groups driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([live()])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups driftDetect: reports a group someone disabled by hand', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ enabled: false })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'San Jose Connectors.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups driftDetect: reports a re-described and re-located group', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ description: 'edited in the admin portal', location: 'Frankfurt, DE' })]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)

    const description = result.diffs.find((d) => d.field === 'San Jose Connectors.description')
    assert.ok(description, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(description.expected, 'desired description')
    assert.equal(description.actual, 'edited in the admin portal')
    assert.equal(description.severity, 'info')

    const location = result.diffs.find((d) => d.field === 'San Jose Connectors.location')
    assert.ok(location, `expected a location diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(location.expected, 'San Jose, CA, USA')
    assert.equal(location.actual, 'Frankfurt, DE')
    assert.equal(location.severity, 'warning')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups driftDetect: attributes a manual change to the ZPA admin id that made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: '216196257331370351', modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'San Jose Connectors.enabled') as
      | { actor?: { id?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.id, '216196257331370351')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups driftDetect: does not attribute drift to our own OneAPI client', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ enabled: false, modifiedBy: CLIENT_ID, modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'San Jose Connectors.enabled') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'a change recorded under our own client id is not a manual change')
  } finally {
    restore()
  }
})

test('zpa-app-connector-groups driftDetect: makes no call without a ZPA customer id', async () => {
  // NOTE: what this returns on this path is deliberately not asserted — see the
  // report. It cannot address the tenant at all, yet answers like a clean check.
  const { calls, restore } = recordFetch([])
  try {
    await driftDetect(driftContext([GROUP], { settings: settingsWithoutCustomerId() }))

    assert.equal(calls.length, 0, 'ZPA is unaddressable without a customer id')
  } finally {
    restore()
  }
})
