// driftDetect for zia-network-service-groups.
//
// The shared contract covers the invariants: drift never writes, a deleted group
// is critical drift, and a 500 is never reported as the group being gone. What is
// specific here is the comparison itself — description plus the member set, which
// deploy writes as `{ id }` references but drift compares by the NAMES ZIA echoes
// back on the live group, sorted so member order is not drift — and the
// attribution that rides on the live object's `lastModifiedBy`.

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

const GROUP = item('Vendor Access', {
  name: 'Vendor Access',
  description: 'desired description',
  services: 'Vendor SFTP\nVendor HTTPS',
})

registerDriftContract({
  label: 'zia-network-service-groups',
  handler: driftDetect,
  product: 'zia',
  items: [GROUP],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 5001,
  name: 'Vendor Access',
  description: 'desired description',
  services: [
    { id: 7001, name: 'Vendor SFTP' },
    { id: 7002, name: 'Vendor HTTPS' },
  ],
  ...over,
})

test('zia-network-service-groups driftDetect: reports no drift when the tenant matches', async () => {
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

test('zia-network-service-groups driftDetect: member order is not drift, but a removed member is', async () => {
  const reordered = recordFetch([
    TOKEN,
    ziaList([
      live({
        services: [
          { id: 7002, name: 'Vendor HTTPS' },
          { id: 7001, name: 'Vendor SFTP' },
        ],
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))
    assert.equal(result.hasDrift, false, 'ZIA returns members in its own order — that is not a change')
  } finally {
    reordered.restore()
  }

  const removed = recordFetch([TOKEN, ziaList([live({ services: [{ id: 7001, name: 'Vendor SFTP' }] })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))
    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Vendor Access.services')
    assert.ok(diff, `expected a services diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'Vendor HTTPS, Vendor SFTP')
    assert.equal(diff.actual, 'Vendor SFTP')
  } finally {
    removed.restore()
  }
})

test('zia-network-service-groups driftDetect: a member added in the console is drift', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        services: [
          { id: 7001, name: 'Vendor SFTP' },
          { id: 7002, name: 'Vendor HTTPS' },
          { id: 7003, name: 'Unrelated' },
        ],
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Vendor Access.services')
    assert.ok(diff)
    assert.match(String(diff.actual), /Unrelated/)
  } finally {
    restore()
  }
})

test('zia-network-service-groups driftDetect: reports a changed description', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ description: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Vendor Access.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-network-service-groups driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        services: [{ id: 7001, name: 'Vendor SFTP' }],
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Vendor Access.services') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-network-service-groups driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        description: 'edited by the pipeline',
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GROUP]))

    const diff = result.diffs.find((d) => d.field === 'Vendor Access.description') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
