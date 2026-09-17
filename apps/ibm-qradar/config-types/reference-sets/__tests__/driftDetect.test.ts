// driftDetect for reference-sets.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: this type reads each set by name, so it can tell "the console
// says this set is gone" (404 — a real, critical diff) apart from "the console
// could not answer" (5xx — `checked: false`), which is the distinction the
// whole drift contract rests on.

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
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const BLOCKED = item('Blocked Domains', {
  name: 'Blocked Domains',
  elementType: 'ALN',
  values: 'evil.example\nbad.example',
})

registerDriftGuardContract({ label: 'reference-sets', handler: driftDetect, sampleItems: [BLOCKED] })

function liveSet(elementType: string, values: string[]) {
  return ok({ name: 'Blocked Domains', element_type: elementType, data: values.map((value) => ({ value })) })
}

test('reference-sets driftDetect: reports in sync when the live set matches', async () => {
  const { calls, restore } = recordFetch([liveSet('ALN', ['bad.example', 'evil.example'])])
  try {
    const result = await driftDetect(driftContext([BLOCKED]))

    assert.equal(pathOf(calls[0]), '/reference_data/sets/Blocked%20Domains')
    assert.equal(calls[0].range, 'items=0-9999')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('reference-sets driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would ask for that name instead and report the real set as missing.
  const { calls, restore } = recordFetch([liveSet('ALN', ['evil.example', 'bad.example'])])
  try {
    const result = await driftDetect(driftContext([BLOCKED]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), '/reference_data/sets/Blocked%20Domains')
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('reference-sets driftDetect: reports a set deleted in the console as critical', async () => {
  const { restore } = recordFetch([notFound()])
  try {
    const result = await driftDetect(driftContext([BLOCKED]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Blocked Domains', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, '404 is an answer, so the run did check')
  } finally {
    restore()
  }
})

test('reference-sets driftDetect: reports values edited in the console', async () => {
  const { restore } = recordFetch([liveSet('ALN', ['evil.example', 'someone-added-this.example'])])
  try {
    const result = await driftDetect(driftContext([BLOCKED]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Blocked Domains.values')
    assert.ok(diff, `expected a values diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.deepEqual(diff.expected, ['bad.example', 'evil.example'])
    assert.deepEqual(diff.actual, ['evil.example', 'someone-added-this.example'])
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('reference-sets driftDetect: a set recreated with another element type is critical', async () => {
  const { restore } = recordFetch([liveSet('IP', [])])
  try {
    const result = await driftDetect(driftContext([BLOCKED]))

    const diff = result.diffs.find((d) => d.field === 'Blocked Domains.element_type')
    assert.ok(diff)
    assert.equal(diff.expected, 'ALN')
    assert.equal(diff.actual, 'IP')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('reference-sets driftDetect: an unreadable set is "could not check", never "absent"', async () => {
  // This is the distinction the whole contract rests on: a 500 must not become
  // `actual: 'absent', severity: 'critical'`, and must not let the run report a
  // bare `hasDrift: false` that clears a real outstanding drift record.
  const { restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await driftDetect(driftContext([BLOCKED]))

    assert.deepEqual(result.diffs, [], 'a failed read is not evidence the set was deleted')
    assert.equal(result.hasDrift, false)
    assert.equal(result.checked, false, 'a run that could not look must not claim it checked')
  } finally {
    restore()
  }
})

test('reference-sets driftDetect: one unreadable set does not hide drift found in another', async () => {
  const OTHER = item('Watchlist', { name: 'Watchlist', elementType: 'ALN', values: 'keep.example' })
  const { restore } = routeFetch([
    { url: /\/reference_data\/sets\/Blocked%20Domains$/, respond: serverError() },
    { url: /\/reference_data\/sets\/Watchlist$/, respond: notFound() },
  ])
  try {
    const result = await driftDetect(driftContext([BLOCKED, OTHER]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs.map((d) => d.field), ['Watchlist'])
    assert.equal(result.checked, false, 'the run is still only partly checked')
  } finally {
    restore()
  }
})

test('reference-sets driftDetect: an empty deployed config checks nothing and reports in sync', async () => {
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
