// driftDetect for log-source-groups.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: the API has no update endpoint, so every diff this handler
// emits is advisory — a redeploy cannot correct it. That makes reporting it at
// all the only thing standing between the operator and a silent divergence.

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

const PATH = '/config/event_sources/log_source_management/log_source_groups'

const FIREWALLS = item('Firewalls', { name: 'Firewalls', description: 'Perimeter firewalls', parentName: '' }, 'item-fw')
const PALO_ALTO = item('Palo Alto', { name: 'Palo Alto', description: '', parentName: 'Firewalls' }, 'item-pan')

registerDriftGuardContract({ label: 'log-source-groups', handler: driftDetect, sampleItems: [FIREWALLS] })

test('log-source-groups driftDetect: reports in sync when the live groups match', async () => {
  const { calls, restore } = recordFetch([
    list([
      { id: 12, name: 'Firewalls', description: 'Perimeter firewalls' },
      { id: 13, name: 'Palo Alto', description: '', parent_id: 12 },
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([FIREWALLS, PALO_ALTO]))

    assert.equal(calls.length, 1, 'one list read serves every declared group')
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999', 'a partial page would report later groups as deleted')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('log-source-groups driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would look for that name and report the real group as deleted.
  const { restore } = recordFetch([list([{ id: 12, name: 'Firewalls', description: 'Perimeter firewalls' }])])
  try {
    const result = await driftDetect(driftContext([FIREWALLS]))

    assert.equal(result.hasDrift, false, 'the decoy canvas item must not be compared')
  } finally {
    restore()
  }
})

test('log-source-groups driftDetect: reports a group deleted in the console as critical', async () => {
  // A 200 with an empty list is a real answer: the console says the group is
  // not there. Log sources assigned to it lose their grouping silently.
  const { restore } = recordFetch([list([])])
  try {
    const result = await driftDetect(driftContext([FIREWALLS]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Firewalls', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, 'an answered read did check')
  } finally {
    restore()
  }
})

test('log-source-groups driftDetect: reports a description edited in the console', async () => {
  const { restore } = recordFetch([list([{ id: 12, name: 'Firewalls', description: 'edited by hand' }])])
  try {
    const result = await driftDetect(driftContext([FIREWALLS]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Firewalls.description', expected: 'Perimeter firewalls', actual: 'edited by hand', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('log-source-groups driftDetect: reports a group re-parented in the console', async () => {
  // There is no re-parent endpoint, so this diff is the only way the operator
  // learns the hierarchy no longer matches the canvas.
  const { restore } = recordFetch([
    list([
      { id: 12, name: 'Firewalls', description: 'Perimeter firewalls' },
      { id: 13, name: 'Palo Alto', description: '', parent_id: 99 },
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([FIREWALLS, PALO_ALTO]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Palo Alto.parentName', expected: 'Firewalls', actual: '99', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('log-source-groups driftDetect: a group moved to the root is reported, not skipped', async () => {
  // `parent_id` absent means the group now sits at the root. Treating a missing
  // field as "matches" would hide the most common manual edit of all.
  const { restore } = recordFetch([
    list([
      { id: 12, name: 'Firewalls', description: 'Perimeter firewalls' },
      { id: 13, name: 'Palo Alto', description: '' },
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([PALO_ALTO, FIREWALLS]))

    const diff = result.diffs.find((d) => d.field === 'Palo Alto.parentName')
    assert.ok(diff, `expected a parentName diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, 'Firewalls')
    assert.equal(diff.actual, '')
    assert.equal(result.hasDrift, true)
  } finally {
    restore()
  }
})

test('log-source-groups driftDetect: an empty deployed config reports in sync and writes nothing', async () => {
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

// NOTE: `listJson` (lib/lookups.ts:78) returns [] when the list read fails, so a
// 500 makes every declared group report `actual: 'absent', severity: 'critical'`
// with no `checked: false`. That path is deliberately unasserted — it is a
// defect, not a contract.
//
// Also unasserted: when the DECLARED PARENT is not in the live list,
// `expectedParentId` is undefined and driftDetect.ts:31 skips the parent
// comparison entirely, so a child whose parent was deleted reports in sync.
