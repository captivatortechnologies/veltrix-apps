// driftDetect for flow-vlans.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: a flow VLAN has no name, so drift is keyed on the
// (enterprise_vlan_id, customer_vlan_id) PAIR and only reported under the
// canvas label. A handler that compared labels would report every pair as
// missing the moment somebody renamed one in the canvas.

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

const PATH = '/ariel/flow_vlans'

const GUEST = item('Guest WiFi', { label: 'Guest WiFi', enterpriseVlanId: 10, customerVlanId: 200 }, 'item-guest')
const LAB = item('Lab', { label: 'Lab', enterpriseVlanId: 20, customerVlanId: 400 }, 'item-lab')

registerDriftGuardContract({ label: 'flow-vlans', handler: driftDetect, sampleItems: [GUEST] })

test('flow-vlans driftDetect: reports in sync when both declared pairs are live', async () => {
  const { calls, restore } = recordFetch([
    list([
      { id: 12, enterprise_vlan_id: 10, customer_vlan_id: 200 },
      { id: 13, enterprise_vlan_id: 20, customer_vlan_id: 400 },
      { id: 14, enterprise_vlan_id: 99, customer_vlan_id: 999 },
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([GUEST, LAB]))

    assert.equal(calls.length, 1, 'one list read serves every declared pair')
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999', 'a partial page would report later pairs as deleted')
    assert.equal(result.hasDrift, false, 'an undeclared extra pair is not drift for this type')
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('flow-vlans driftDetect: matches on the pair, not on the label', async () => {
  // The live API returns no label at all, so a comparison that leaned on one
  // would report drift on every renamed canvas item.
  const RELABELLED = item('Renamed', { label: 'Renamed', enterpriseVlanId: 10, customerVlanId: 200 }, 'item-other')
  const { restore } = recordFetch([list([{ id: 12, enterprise_vlan_id: 10, customer_vlan_id: 200 }])])
  try {
    const result = await driftDetect(driftContext([RELABELLED]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('flow-vlans driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. Its VLAN fields are
  // absent, so a handler reading the canvas would look for pair 0:0 and report
  // the real pair as deleted.
  const { restore } = recordFetch([list([{ id: 12, enterprise_vlan_id: 10, customer_vlan_id: 200 }])])
  try {
    const result = await driftDetect(driftContext([GUEST]))

    assert.equal(result.hasDrift, false, 'the decoy canvas item must not be compared')
  } finally {
    restore()
  }
})

test('flow-vlans driftDetect: reports a pair removed in the console as critical, under its label', async () => {
  const { restore } = recordFetch([list([{ id: 13, enterprise_vlan_id: 20, customer_vlan_id: 400 }])])
  try {
    const result = await driftDetect(driftContext([GUEST, LAB]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Guest WiFi', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, 'an answered read did check')
  } finally {
    restore()
  }
})

test('flow-vlans driftDetect: a pair whose customer VLAN was edited reports as absent', async () => {
  // Identity is the pair, so an edited VLAN id is a different object entirely —
  // the declared pair really is gone and flows for it are no longer classified.
  const { restore } = recordFetch([list([{ id: 12, enterprise_vlan_id: 10, customer_vlan_id: 201 }])])
  try {
    const result = await driftDetect(driftContext([GUEST]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Guest WiFi', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('flow-vlans driftDetect: a live row with no enterprise VLAN matches a spec declaring 0', async () => {
  // QRadar omits the field when there is no enterprise VLAN. Reading the absent
  // field as anything but 0 would report a healthy pair as deleted on every run.
  const FLAT = item('Flat VLAN', { label: 'Flat VLAN', customerVlanId: 300 }, 'item-flat')
  const { restore } = recordFetch([list([{ id: 3, customer_vlan_id: 300 }])])
  try {
    const result = await driftDetect(driftContext([FLAT]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('flow-vlans driftDetect: an empty deployed config reports in sync and writes nothing', async () => {
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

// NOTE: `listFlowVlans` (deploy.ts:25) returns [] when the list read fails, so a
// 500 makes every declared pair report `actual: 'absent', severity: 'critical'`
// with no `checked: false`. That path is deliberately unasserted — it is a
// defect, not a contract.
