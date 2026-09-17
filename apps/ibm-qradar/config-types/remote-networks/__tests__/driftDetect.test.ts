// driftDetect for remote-networks.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: this type reads the whole staged list once and compares each
// declared network field by field, so the assertions below are about reading
// the DEPLOYED config rather than the live canvas, and about emitting a diff
// for every field that actually moved.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  driftContext,
  item,
  list,
  pathOf,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/staged_config/remote_networks'

const DMZ = item(
  'DMZ',
  {
    name: 'DMZ',
    description: 'Perimeter networks',
    group: 'Perimeter',
    cidrs: '10.0.0.0/8\n172.16.0.0/12',
  },
  'item-dmz',
)

function liveDmz(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: 'DMZ',
    description: 'Perimeter networks',
    group: 'Perimeter',
    cidrs: ['10.0.0.0/8', '172.16.0.0/12'],
    ...over,
  }
}

registerDriftGuardContract({ label: 'remote-networks', handler: driftDetect, sampleItems: [DMZ] })

test('remote-networks driftDetect: reports in sync when the live network matches', async () => {
  const { calls, restore } = recordFetch([list([liveDmz({ cidrs: ['172.16.0.0/12', '10.0.0.0/8'] })])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999', 'a partial page would report later networks as deleted')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('remote-networks driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would look for that name and report the real network as deleted.
  const { restore } = recordFetch([list([liveDmz()])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    assert.equal(result.hasDrift, false, 'the decoy canvas item must not be compared')
  } finally {
    restore()
  }
})

test('remote-networks driftDetect: reports a network deleted in the console as critical', async () => {
  // A 200 with an empty list is a real answer: the console says the network is
  // not there.
  const { restore } = recordFetch([list([])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [{ field: 'DMZ', expected: 'present', actual: 'absent', severity: 'critical' }])
    assert.equal(result.checked, undefined, 'an answered read did check')
  } finally {
    restore()
  }
})

test('remote-networks driftDetect: reports CIDR ranges edited in the console', async () => {
  const { restore } = recordFetch([list([liveDmz({ cidrs: ['10.0.0.0/8', '203.0.113.0/24'] })])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'DMZ.cidrs')
    assert.ok(diff, `expected a cidrs diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, '10.0.0.0/8, 172.16.0.0/12')
    assert.equal(diff.actual, '10.0.0.0/8, 203.0.113.0/24')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('remote-networks driftDetect: reports the description and the group separately', async () => {
  const { restore } = recordFetch([list([liveDmz({ description: 'renamed by hand', group: 'Legacy' })])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    assert.deepEqual(
      result.diffs.map((d) => [d.field, d.expected, d.actual]),
      [
        ['DMZ.description', 'Perimeter networks', 'renamed by hand'],
        ['DMZ.group', 'Perimeter', 'Legacy'],
      ],
    )
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})

test('remote-networks driftDetect: a network that lost its CIDRs entirely still reports a diff', async () => {
  // `cidrs` absent from the response must not read as "matches"; an emptied
  // remote network silently reclassifies traffic as local.
  const { restore } = recordFetch([list([{ id: 42, name: 'DMZ', description: 'Perimeter networks', group: 'Perimeter' }])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    const diff = result.diffs.find((d) => d.field === 'DMZ.cidrs')
    assert.ok(diff)
    assert.equal(diff.actual, '')
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})

test('remote-networks driftDetect: an empty deployed config reports in sync and writes nothing', async () => {
  const { calls, restore } = recordFetch([list([])])
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined)
  } finally {
    restore()
  }
})

// NOTE: `listRemoteNetworks` (deploy.ts:31) returns [] when the list read fails,
// so a 500 makes every declared network report `actual: 'absent', severity:
// 'critical'` with no `checked: false`. That path is deliberately unasserted —
// it is a defect, not a contract.
