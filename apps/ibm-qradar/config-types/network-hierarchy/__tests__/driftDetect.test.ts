// driftDetect for network-hierarchy.
//
// Identity is the (group, name) pair, so the check is: is every declared object
// still in the staged list, and does its CIDR still say what the canvas says?
// A repointed CIDR is precisely the change drift detection exists to catch —
// it silently reroutes which events QRadar treats as internal.

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

const DMZ = item('DMZ', {
  group: 'Perimeter',
  name: 'DMZ',
  cidr: '10.20.0.0/16',
  description: 'Perimeter DMZ range',
})

registerDriftGuardContract({ label: 'network-hierarchy', handler: driftDetect, sampleItems: [DMZ] })

function liveNetwork(over: Record<string, unknown> = {}) {
  return { id: 902, group: 'Perimeter', name: 'DMZ', cidr: '10.20.0.0/16', description: 'Perimeter DMZ range', ...over }
}

test('network-hierarchy driftDetect: reports in sync when the staged object matches', async () => {
  const { calls, restore } = recordFetch([list([liveNetwork(), { id: 901, group: 'Corp', name: 'Office' }])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), '/config/network_hierarchy/staged_networks')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(
      result.diffs.length,
      0,
      'an operator object the canvas does not declare is not drift — this type shares the list',
    )
  } finally {
    restore()
  }
})

test('network-hierarchy driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas` with no group at all. A
  // handler reading the canvas would report the real object as missing.
  const { restore } = recordFetch([list([liveNetwork()])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('network-hierarchy driftDetect: reports a CIDR repointed in the console', async () => {
  const { restore } = recordFetch([list([liveNetwork({ cidr: '10.20.0.0/24' })])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Perimeter/DMZ.cidr', expected: '10.20.0.0/16', actual: '10.20.0.0/24', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('network-hierarchy driftDetect: reports a declared object deleted from the hierarchy', async () => {
  const { restore } = recordFetch([list([{ id: 901, group: 'Corp', name: 'Office', cidr: '192.168.0.0/16' }])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Perimeter/DMZ', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('network-hierarchy driftDetect: an object moved to another group reads as absent', async () => {
  // Identity is (group, name), so re-grouping IS a deletion from this config
  // type's point of view — and the next deploy will recreate it in the old group.
  const { restore } = recordFetch([list([liveNetwork({ group: 'Lab' })])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].field, 'Perimeter/DMZ')
    assert.equal(result.diffs[0].actual, 'absent')
  } finally {
    restore()
  }
})

test('network-hierarchy driftDetect: reports a description edited in the console', async () => {
  const { restore } = recordFetch([list([liveNetwork({ description: 'changed by hand' })])])
  try {
    const result = await driftDetect(driftContext([DMZ]))

    const diff = result.diffs.find((d) => d.field === 'Perimeter/DMZ.description')
    assert.ok(diff)
    assert.equal(diff.actual, 'changed by hand')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('network-hierarchy driftDetect: an empty deployed config reports in sync', async () => {
  const { restore } = recordFetch([list([{ id: 901, group: 'Corp', name: 'Office' }])])
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})
