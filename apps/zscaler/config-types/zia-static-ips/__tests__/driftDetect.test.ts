// driftDetect for zia-static-ips.
//
// The shared contract covers the invariants: drift never writes, a deleted
// static IP is critical drift, and a 500 is never reported as the static IP
// being gone. What is specific here is the comparison itself — the managed
// comment and the geo-override flag — and the attribution that rides on the live
// object's `lastModifiedBy`.
//
// `routableIP` is written by deploy and is NOT compared here, so a static IP
// flipped to non-routable in the ZIA console reads as in sync. That is left
// deliberately unasserted (asserting it would bless it) and is reported instead.

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

const STATIC_IP = item('Chicago egress', {
  ip_address: '203.0.113.10',
  comment: 'Chicago DC egress',
  geo_override: true,
  latitude: 41.8781,
  longitude: -87.6298,
})

registerDriftContract({
  label: 'zia-static-ips',
  handler: driftDetect,
  product: 'zia',
  items: [STATIC_IP],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 4242,
  ipAddress: '203.0.113.10',
  comment: 'Chicago DC egress',
  geoOverride: true,
  latitude: 41.8781,
  longitude: -87.6298,
  routableIP: true,
  ...over,
})

test('zia-static-ips driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([STATIC_IP]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-static-ips driftDetect: reports a changed comment', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ comment: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([STATIC_IP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === '203.0.113.10.comment')
    assert.ok(diff, `expected a comment diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'Chicago DC egress')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-static-ips driftDetect: reports a geo override turned off in the console', async () => {
  // The geolocation decides which Zscaler data centre the IP is treated as
  // sitting in, so an override silently removed is a real change.
  const { restore } = recordFetch([TOKEN, ziaList([live({ geoOverride: false })])])
  try {
    const result = await driftDetect(driftContext([STATIC_IP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === '203.0.113.10.geoOverride')
    assert.ok(diff)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
  } finally {
    restore()
  }
})

test('zia-static-ips driftDetect: a comment cleared in the console reads as "not set"', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ comment: '   ' })])])
  try {
    const result = await driftDetect(driftContext([STATIC_IP]))

    const diff = result.diffs.find((d) => d.field === '203.0.113.10.comment')
    assert.ok(diff)
    assert.equal(diff.actual, 'not set')
  } finally {
    restore()
  }
})

test('zia-static-ips driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        comment: 'edited in the ZIA console',
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([STATIC_IP]))

    const diff = result.diffs.find((d) => d.field === '203.0.113.10.comment') as
      | { actor?: { name?: string; email?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z', 'ZIA records epoch SECONDS')
  } finally {
    restore()
  }
})

test('zia-static-ips driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        comment: 'set by the pipeline',
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([STATIC_IP]))

    const diff = result.diffs.find((d) => d.field === '203.0.113.10.comment') as { actor?: unknown } | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
