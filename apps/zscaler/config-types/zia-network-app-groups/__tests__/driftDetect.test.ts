// driftDetect for zia-network-app-groups.
//
// The shared contract covers the invariants: drift never writes, a deleted group
// is critical drift, and a 500 is never reported as the group being gone. What
// is specific here is the comparison itself — description plus the member
// application ids, sorted on both sides before comparing, and REPORTED sorted
// rather than in authored order — and the attribution that rides on the live
// object's `lastModifiedBy`.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  item,
  recordFetch,
  writeCalls,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const GROUP = item('Collab apps', {
  name: 'Collab apps',
  description: 'desired description',
  network_applications: 'WEBEX\nAPNS\nZOOM',
})

registerDriftContract({
  label: 'zia-network-app-groups',
  handler: driftDetect,
  product: 'zia',
  items: [GROUP],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 6611,
  name: 'Collab apps',
  description: 'desired description',
  networkApplications: ['APNS', 'WEBEX', 'ZOOM'],
  ...over,
})

test('zia-network-app-groups driftDetect: reports no drift when the tenant matches', async () => {
  // The canvas authors WEBEX, APNS, ZOOM and ZIA returns them alphabetically —
  // membership is a set, so that is not a change.
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-network-app-groups driftDetect: reports an application added to the group by hand', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ networkApplications: ['APNS', 'WEBEX', 'ZOOM', 'BITTORRENT'] })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Collab apps.networkApplications')
    assert.ok(diff, `expected a networkApplications diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'APNS, WEBEX, ZOOM', 'both sides are reported sorted')
    assert.equal(diff.actual, 'APNS, BITTORRENT, WEBEX, ZOOM')
  } finally {
    restore()
  }
})

test('zia-network-app-groups driftDetect: reports a group emptied in the console', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ networkApplications: [] })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Collab apps.networkApplications')
    assert.ok(diff)
    assert.equal(diff.actual, 'not set')
  } finally {
    restore()
  }
})

test('zia-network-app-groups driftDetect: reports a changed description', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ description: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Collab apps.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-network-app-groups driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        networkApplications: ['APNS'],
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Collab apps.networkApplications') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-network-app-groups driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        networkApplications: ['APNS'],
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Collab apps.networkApplications') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
