// driftDetect for zia-ip-destination-groups.
//
// The shared contract covers the invariants: drift never writes, a deleted group
// is critical drift, and a 500 is never reported as the group being gone. What
// is specific here is the comparison itself — description, the destination
// `type`, and the address set compared order-independently — plus the
// attribution that rides on the live object's `lastModifiedBy`.
//
// NOT asserted here: `countries`. deploy WRITES it and driftDetect never
// compares it, so a DSTN_OTHER group whose country list was widened by hand
// comes back in sync. Asserting that would bless it; it is in the report
// accompanying these tests.

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

const GROUP = item('Partner egress', {
  name: 'Partner egress',
  description: 'desired description',
  type: 'DSTN_IP',
  addresses: '203.0.113.0/24\n198.51.100.7',
})

registerDriftContract({
  label: 'zia-ip-destination-groups',
  handler: driftDetect,
  product: 'zia',
  items: [GROUP],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 3311,
  name: 'Partner egress',
  description: 'desired description',
  type: 'DSTN_IP',
  addresses: ['203.0.113.0/24', '198.51.100.7'],
  ...over,
})

test('zia-ip-destination-groups driftDetect: reports no drift when the tenant matches', async () => {
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

test('zia-ip-destination-groups driftDetect: address order is not drift, but a changed address set is', async () => {
  const reordered = recordFetch([TOKEN, ziaList([live({ addresses: ['198.51.100.7', '203.0.113.0/24'] })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))
    assert.equal(result.hasDrift, false, 'ZIA returns addresses in its own order — that is not a change')
  } finally {
    reordered.restore()
  }

  const changed = recordFetch([TOKEN, ziaList([live({ addresses: ['203.0.113.0/24', '192.0.2.0/24'] })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))
    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Partner egress.addresses')
    assert.ok(diff, `expected an addresses diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /192\.0\.2\.0\/24/)
    assert.equal(diff.severity, 'warning')
  } finally {
    changed.restore()
  }
})

test('zia-ip-destination-groups driftDetect: reports a changed destination type', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ type: 'DSTN_FQDN' })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Partner egress.type')
    assert.ok(diff, `expected a type diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'DSTN_IP')
    assert.equal(diff.actual, 'DSTN_FQDN')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups driftDetect: reports a changed description', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ description: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Partner egress.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        addresses: ['203.0.113.0/24', '192.0.2.0/24'],
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Partner egress.addresses') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-ip-destination-groups driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        addresses: ['203.0.113.0/24', '192.0.2.0/24'],
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Partner egress.addresses') as { actor?: unknown } | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
