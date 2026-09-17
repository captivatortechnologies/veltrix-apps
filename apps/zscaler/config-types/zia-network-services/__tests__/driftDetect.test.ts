// driftDetect for zia-network-services.
//
// The shared contract covers the invariants: drift never writes, a deleted
// service is critical drift, and a 500 is never reported as the service being
// gone. What is specific here is the comparison itself — description plus the
// TCP and UDP destination port sets, canonicalised so ZIA returning the ranges in
// its own order is not reported as a change — and the attribution that rides on
// the live object's `lastModifiedBy`.

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

const SERVICE = item('Vendor SFTP', {
  name: 'Vendor SFTP',
  description: 'desired description',
  tcp_ports: '22\n8000-8100',
  udp_ports: '53',
})

registerDriftContract({
  label: 'zia-network-services',
  handler: driftDetect,
  product: 'zia',
  items: [SERVICE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 7001,
  name: 'Vendor SFTP',
  type: 'CUSTOM',
  description: 'desired description',
  destTcpPorts: [
    { start: 22, end: 22 },
    { start: 8000, end: 8100 },
  ],
  destUdpPorts: [{ start: 53, end: 53 }],
  ...over,
})

test('zia-network-services driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([SERVICE]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-network-services driftDetect: port order is not drift, but an added port is', async () => {
  const reordered = recordFetch([
    TOKEN,
    ziaList([
      live({
        destTcpPorts: [
          { start: 8000, end: 8100 },
          { start: 22, end: 22 },
        ],
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([SERVICE]))
    assert.equal(result.hasDrift, false, 'ZIA returns port ranges in its own order — that is not a change')
  } finally {
    reordered.restore()
  }

  const widened = recordFetch([
    TOKEN,
    ziaList([
      live({
        destTcpPorts: [
          { start: 22, end: 22 },
          { start: 8000, end: 8100 },
          { start: 3389, end: 3389 },
        ],
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([SERVICE]))
    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Vendor SFTP.tcp_ports')
    assert.ok(diff, `expected a tcp_ports diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /3389-3389/)
    assert.equal(diff.expected, '22-22,8000-8100')
  } finally {
    widened.restore()
  }
})

test('zia-network-services driftDetect: a UDP port set emptied in the console is drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ destUdpPorts: [] })])])
  try {
    const result = await driftDetect(driftContext([SERVICE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Vendor SFTP.udp_ports')
    assert.ok(diff, `expected a udp_ports diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '53-53')
    assert.equal(diff.actual, 'none')
  } finally {
    restore()
  }
})

test('zia-network-services driftDetect: reports a changed description', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ description: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([SERVICE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Vendor SFTP.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-network-services driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        destTcpPorts: [{ start: 22, end: 22 }],
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([SERVICE]))

    const diff = result.diffs.find((d) => d.field === 'Vendor SFTP.tcp_ports') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-network-services driftDetect: does not attribute our own deploy as a manual change', async () => {
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
    const result = await driftDetect(driftContext([SERVICE]))

    const diff = result.diffs.find((d) => d.field === 'Vendor SFTP.description') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
