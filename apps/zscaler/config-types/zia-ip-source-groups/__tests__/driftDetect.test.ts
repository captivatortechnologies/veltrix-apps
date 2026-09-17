// driftDetect for zia-ip-source-groups.
//
// The shared contract covers the invariants: drift never writes, a deleted group
// is critical drift, and a 500 is never reported as the group being gone. What
// is specific here is the comparison itself — description plus the source IP
// set, compared order-independently because ZIA returns the array in its own
// order — and the attribution that rides on the live object's `lastModifiedBy`.
//
// Every field deploy writes is compared here; the one thing worth noting is the
// SEVERITY: a changed source IP set is emitted as `info`, the same weight as a
// changed description, even though it is the field that scopes firewall rules.

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

const GROUP = item('Branch sources', {
  name: 'Branch sources',
  description: 'desired description',
  ip_addresses: '203.0.113.0/24\n198.51.100.7',
})

registerDriftContract({
  label: 'zia-ip-source-groups',
  handler: driftDetect,
  product: 'zia',
  items: [GROUP],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 5511,
  name: 'Branch sources',
  description: 'desired description',
  ipAddresses: ['203.0.113.0/24', '198.51.100.7'],
  ...over,
})

test('zia-ip-source-groups driftDetect: reports no drift when the tenant matches', async () => {
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

test('zia-ip-source-groups driftDetect: address order is not drift, but a widened source range is', async () => {
  const reordered = recordFetch([TOKEN, ziaList([live({ ipAddresses: ['198.51.100.7', '203.0.113.0/24'] })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))
    assert.equal(result.hasDrift, false, 'ZIA returns addresses in its own order — that is not a change')
  } finally {
    reordered.restore()
  }

  const widened = recordFetch([TOKEN, ziaList([live({ ipAddresses: ['203.0.113.0/24', '0.0.0.0/0'] })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))
    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Branch sources.ipAddresses')
    assert.ok(diff, `expected an ipAddresses diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /0\.0\.0\.0\/0/)
  } finally {
    widened.restore()
  }
})

test('zia-ip-source-groups driftDetect: reports a source group emptied in the console', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ ipAddresses: [] })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Branch sources.ipAddresses')
    assert.ok(diff)
    assert.equal(diff.expected, '203.0.113.0/24, 198.51.100.7')
    assert.equal(diff.actual, 'not set')
  } finally {
    restore()
  }
})

test('zia-ip-source-groups driftDetect: reports a changed description', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ description: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Branch sources.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-ip-source-groups driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        ipAddresses: ['0.0.0.0/0'],
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Branch sources.ipAddresses') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-ip-source-groups driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        ipAddresses: ['0.0.0.0/0'],
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Branch sources.ipAddresses') as { actor?: unknown } | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
