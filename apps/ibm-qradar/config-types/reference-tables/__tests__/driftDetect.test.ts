// driftDetect for reference-tables.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: this type reads each table by name, so it can tell "the
// console says this table is gone" (404 — a real, critical diff) apart from
// "the console could not answer" (5xx — `checked: false`), which is the
// distinction the whole drift contract rests on.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  driftContext,
  item,
  notFound,
  ok,
  pathOf,
  recordFetch,
  routeFetch,
  serverError,
  transportFailure,
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const USER_ROLES = item('User Roles', {
  name: 'User Roles',
  elementType: 'ALN',
  columns: 'srcip: IP\nrole: ALN',
  cells: 'alice | srcip = 10.0.0.1\nalice | role = admin',
})

registerDriftGuardContract({ label: 'reference-tables', handler: driftDetect, sampleItems: [USER_ROLES] })

function liveTable(elementType: string, rows: Record<string, Record<string, string>>) {
  return ok({
    name: 'User Roles',
    element_type: elementType,
    data: Object.fromEntries(
      Object.entries(rows).map(([outer, inner]) => [
        outer,
        Object.fromEntries(Object.entries(inner).map(([col, value]) => [col, { value }])),
      ]),
    ),
  })
}

test('reference-tables driftDetect: reports in sync when the live table matches', async () => {
  const { calls, restore } = recordFetch([liveTable('ALN', { alice: { role: 'admin', srcip: '10.0.0.1' } })])
  try {
    const result = await driftDetect(driftContext([USER_ROLES]))

    assert.equal(pathOf(calls[0]), '/reference_data/tables/User%20Roles')
    assert.equal(calls[0].range, 'items=0-9999')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('reference-tables driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would ask for that name instead and report the real table as missing.
  const { calls, restore } = recordFetch([liveTable('ALN', { alice: { srcip: '10.0.0.1', role: 'admin' } })])
  try {
    const result = await driftDetect(driftContext([USER_ROLES]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), '/reference_data/tables/User%20Roles')
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('reference-tables driftDetect: reports a table deleted in the console as critical', async () => {
  const { restore } = recordFetch([notFound()])
  try {
    const result = await driftDetect(driftContext([USER_ROLES]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'User Roles', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, '404 is an answer, so the run did check')
  } finally {
    restore()
  }
})

test('reference-tables driftDetect: reports a cell edited in the console', async () => {
  // The cell count is unchanged, so a handler comparing only sizes would call
  // this in sync — while a user has been given a role the canvas never granted.
  const { restore } = recordFetch([liveTable('ALN', { alice: { srcip: '10.0.0.1', role: 'admin-escalated' } })])
  try {
    const result = await driftDetect(driftContext([USER_ROLES]))

    assert.equal(result.hasDrift, true, 'the same number of cells is not the same set of cells')
    const diff = result.diffs.find((d) => d.field === 'User Roles.cells')
    assert.ok(diff, `expected a cells diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('reference-tables driftDetect: reports a row added in the console', async () => {
  const { restore } = recordFetch([
    liveTable('ALN', { alice: { srcip: '10.0.0.1', role: 'admin' }, mallory: { role: 'admin' } }),
  ])
  try {
    const result = await driftDetect(driftContext([USER_ROLES]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'User Roles.cells')
    assert.ok(diff)
    assert.equal(diff.expected, '2 cell(s)')
    assert.equal(diff.actual, '3 cell(s)')
  } finally {
    restore()
  }
})

test('reference-tables driftDetect: a table recreated with another element type is critical', async () => {
  const { restore } = recordFetch([liveTable('IP', { alice: { srcip: '10.0.0.1', role: 'admin' } })])
  try {
    const result = await driftDetect(driftContext([USER_ROLES]))

    const diff = result.diffs.find((d) => d.field === 'User Roles.element_type')
    assert.ok(diff)
    assert.equal(diff.expected, 'ALN')
    assert.equal(diff.actual, 'IP')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('reference-tables driftDetect: an unreadable table is "could not check", never "absent"', async () => {
  // This is the distinction the whole contract rests on: a 500 must not become
  // `actual: 'absent', severity: 'critical'`, and must not let the run report a
  // bare `hasDrift: false` that clears a real outstanding drift record.
  const { restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await driftDetect(driftContext([USER_ROLES]))

    assert.deepEqual(result.diffs, [], 'a failed read is not evidence the table was deleted')
    assert.equal(result.hasDrift, false)
    assert.equal(result.checked, false, 'a run that could not look must not claim it checked')
  } finally {
    restore()
  }
})

test('reference-tables driftDetect: an unreachable console is "could not check", not "in sync"', async () => {
  const { restore } = recordFetch([transportFailure()])
  try {
    const result = await driftDetect(driftContext([USER_ROLES]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, false)
  } finally {
    restore()
  }
})

test('reference-tables driftDetect: one unreadable table does not hide drift found in another', async () => {
  const OTHER = item('Asset Owners', { name: 'Asset Owners', elementType: 'ALN', cells: 'host | owner = ops' })
  const { restore } = routeFetch([
    { url: /\/reference_data\/tables\/User%20Roles$/, respond: serverError() },
    { url: /\/reference_data\/tables\/Asset%20Owners$/, respond: notFound() },
  ])
  try {
    const result = await driftDetect(driftContext([USER_ROLES, OTHER]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['Asset Owners'],
    )
    assert.equal(result.checked, false, 'the run is still only partly checked')
  } finally {
    restore()
  }
})

test('reference-tables driftDetect: an empty deployed config checks nothing and reports in sync', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(calls.length, 0)
    assert.equal(result.hasDrift, false)
    assert.equal(result.checked, undefined)
  } finally {
    restore()
  }
})
