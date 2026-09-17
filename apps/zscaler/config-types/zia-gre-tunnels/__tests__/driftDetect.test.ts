// driftDetect for zia-gre-tunnels.
//
// The shared contract covers the invariants: drift never writes, a deleted
// tunnel is critical drift, and a 500 is never reported as the tunnel being
// gone. What is specific here is the comparison itself — the tunnel is re-found
// by SOURCE IP and only the managed `comment` is diffed — plus the attribution
// that rides on the live object's `lastModifiedBy`.
//
// NOT asserted here: the advanced tunnel fields (primaryDestVip,
// secondaryDestVip, withinCountry, ipUnnumbered). deploy WRITES them, from the
// `gre_json` escape hatch, and driftDetect never compares them, so a tunnel
// repointed at a different Zscaler VIP comes back in sync. Asserting that would
// bless it; it is in the report accompanying these tests.

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

const TUNNEL = item('HQ tunnel', {
  source_ip: '203.0.113.10',
  comment: 'desired comment',
  gre_json: '{"primaryDestVip":{"id":12345},"withinCountry":true}',
})

registerDriftContract({
  label: 'zia-gre-tunnels',
  handler: driftDetect,
  product: 'zia',
  items: [TUNNEL],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 4411,
  sourceIp: '203.0.113.10',
  comment: 'desired comment',
  primaryDestVip: { id: 12345 },
  withinCountry: true,
  ...over,
})

test('zia-gre-tunnels driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([TUNNEL]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-gre-tunnels driftDetect: matches on source IP, not on the canvas item name', async () => {
  // The live tunnel carries no name at all — source IP is the only identity ZIA
  // exposes for a GRE tunnel, and drift has to re-find it by that.
  const { restore } = recordFetch([TOKEN, ziaList([live(), { id: 4400, sourceIp: '198.51.100.1' }])])
  try {
    const result = await driftDetect(driftContext([TUNNEL]))

    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('zia-gre-tunnels driftDetect: reports a changed comment', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ comment: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([TUNNEL]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === '203.0.113.10.comment')
    assert.ok(diff, `expected a comment diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'desired comment')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-gre-tunnels driftDetect: attributes a manual change to the admin who made it', async () => {
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
    const result = await driftDetect(driftContext([TUNNEL]))

    const diff = result.diffs.find((d) => d.field === '203.0.113.10.comment') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-gre-tunnels driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        comment: 'edited by the pipeline',
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([TUNNEL]))

    const diff = result.diffs.find((d) => d.field === '203.0.113.10.comment') as { actor?: unknown } | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
