// driftDetect for reference-map-of-sets.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: this type reads each collection by name, so it can tell "the
// console says this collection is gone" (404 — a real, critical diff) apart
// from "the console could not answer" (5xx — `checked: false`), which is the
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

const ADMIN_USERS = item('Admin Users', {
  name: 'Admin Users',
  elementType: 'ALN',
  entries: 'finance = alice, bob\nops = carol',
})

registerDriftGuardContract({ label: 'reference-map-of-sets', handler: driftDetect, sampleItems: [ADMIN_USERS] })

function liveMapOfSets(elementType: string, data: Record<string, string[]>) {
  return ok({
    name: 'Admin Users',
    element_type: elementType,
    data: Object.fromEntries(
      Object.entries(data).map(([key, values]) => [key, values.map((value) => ({ value }))]),
    ),
  })
}

test('reference-map-of-sets driftDetect: reports in sync when the live collection matches', async () => {
  const { calls, restore } = recordFetch([liveMapOfSets('ALN', { ops: ['carol'], finance: ['bob', 'alice'] })])
  try {
    const result = await driftDetect(driftContext([ADMIN_USERS]))

    assert.equal(pathOf(calls[0]), '/reference_data/map_of_sets/Admin%20Users')
    assert.equal(calls[0].range, 'items=0-9999')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('reference-map-of-sets driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would ask for that name instead and report the real collection as
  // missing.
  const { calls, restore } = recordFetch([liveMapOfSets('ALN', { finance: ['alice', 'bob'], ops: ['carol'] })])
  try {
    const result = await driftDetect(driftContext([ADMIN_USERS]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), '/reference_data/map_of_sets/Admin%20Users')
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('reference-map-of-sets driftDetect: reports a collection deleted in the console as critical', async () => {
  const { restore } = recordFetch([notFound()])
  try {
    const result = await driftDetect(driftContext([ADMIN_USERS]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Admin Users', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, '404 is an answer, so the run did check')
  } finally {
    restore()
  }
})

test('reference-map-of-sets driftDetect: reports a member added in the console', async () => {
  const { restore } = recordFetch([liveMapOfSets('ALN', { finance: ['alice', 'bob'], ops: ['carol', 'mallory'] })])
  try {
    const result = await driftDetect(driftContext([ADMIN_USERS]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Admin Users.entries')
    assert.ok(diff, `expected an entries diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('reference-map-of-sets driftDetect: reports a member moved between keys', async () => {
  // The pair count is unchanged, so a handler comparing only sizes would call
  // this in sync — while an analyst has been moved into another access group.
  const { restore } = recordFetch([liveMapOfSets('ALN', { finance: ['alice'], ops: ['carol', 'bob'] })])
  try {
    const result = await driftDetect(driftContext([ADMIN_USERS]))

    assert.equal(result.hasDrift, true, 'the same number of pairs is not the same set of pairs')
    assert.ok(result.diffs.some((d) => d.field === 'Admin Users.entries'))
  } finally {
    restore()
  }
})

test('reference-map-of-sets driftDetect: a collection recreated with another element type is critical', async () => {
  const { restore } = recordFetch([liveMapOfSets('IP', { finance: ['alice', 'bob'], ops: ['carol'] })])
  try {
    const result = await driftDetect(driftContext([ADMIN_USERS]))

    const diff = result.diffs.find((d) => d.field === 'Admin Users.element_type')
    assert.ok(diff)
    assert.equal(diff.expected, 'ALN')
    assert.equal(diff.actual, 'IP')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('reference-map-of-sets driftDetect: an unreadable collection is "could not check", never "absent"', async () => {
  // This is the distinction the whole contract rests on: a 500 must not become
  // `actual: 'absent', severity: 'critical'`, and must not let the run report a
  // bare `hasDrift: false` that clears a real outstanding drift record.
  const { restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await driftDetect(driftContext([ADMIN_USERS]))

    assert.deepEqual(result.diffs, [], 'a failed read is not evidence the collection was deleted')
    assert.equal(result.hasDrift, false)
    assert.equal(result.checked, false, 'a run that could not look must not claim it checked')
  } finally {
    restore()
  }
})

test('reference-map-of-sets driftDetect: an unreachable console is "could not check", not "in sync"', async () => {
  const { restore } = recordFetch([transportFailure()])
  try {
    const result = await driftDetect(driftContext([ADMIN_USERS]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, false)
  } finally {
    restore()
  }
})

test('reference-map-of-sets driftDetect: one unreadable collection does not hide drift found in another', async () => {
  const OTHER = item('Watchlists', { name: 'Watchlists', elementType: 'ALN', entries: 'keep = me' })
  const { restore } = routeFetch([
    { url: /\/reference_data\/map_of_sets\/Admin%20Users$/, respond: serverError() },
    { url: /\/reference_data\/map_of_sets\/Watchlists$/, respond: notFound() },
  ])
  try {
    const result = await driftDetect(driftContext([ADMIN_USERS, OTHER]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['Watchlists'],
    )
    assert.equal(result.checked, false, 'the run is still only partly checked')
  } finally {
    restore()
  }
})

test('reference-map-of-sets driftDetect: an empty deployed config checks nothing and reports in sync', async () => {
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
