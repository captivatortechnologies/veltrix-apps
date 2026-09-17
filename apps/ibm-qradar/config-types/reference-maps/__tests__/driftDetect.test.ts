// driftDetect for reference-maps.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: this type reads each map by name, so it can tell "the console
// says this map is gone" (404 — a real, critical diff) apart from "the console
// could not answer" (5xx — `checked: false`), which is the distinction the whole
// drift contract rests on.

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

const HOST_MAP = item('Host Map', {
  name: 'Host Map',
  elementType: 'ALN',
  entries: '10.0.0.1=web-server\n10.0.0.2=db-server',
})

registerDriftGuardContract({ label: 'reference-maps', handler: driftDetect, sampleItems: [HOST_MAP] })

function liveMap(elementType: string, pairs: Record<string, string>) {
  return ok({
    name: 'Host Map',
    element_type: elementType,
    data: Object.fromEntries(Object.entries(pairs).map(([key, value]) => [key, { value }])),
  })
}

test('reference-maps driftDetect: reports in sync when the live map matches', async () => {
  const { calls, restore } = recordFetch([liveMap('ALN', { '10.0.0.2': 'db-server', '10.0.0.1': 'web-server' })])
  try {
    const result = await driftDetect(driftContext([HOST_MAP]))

    assert.equal(pathOf(calls[0]), '/reference_data/maps/Host%20Map')
    assert.equal(calls[0].range, 'items=0-9999')
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('reference-maps driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would ask for that name instead and report the real map as missing.
  const { calls, restore } = recordFetch([liveMap('ALN', { '10.0.0.1': 'web-server', '10.0.0.2': 'db-server' })])
  try {
    const result = await driftDetect(driftContext([HOST_MAP]))

    assert.equal(calls.length, 1)
    assert.equal(pathOf(calls[0]), '/reference_data/maps/Host%20Map')
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('reference-maps driftDetect: reports a map deleted in the console as critical', async () => {
  const { restore } = recordFetch([notFound()])
  try {
    const result = await driftDetect(driftContext([HOST_MAP]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'Host Map', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, '404 is an answer, so the run did check')
  } finally {
    restore()
  }
})

test('reference-maps driftDetect: reports an entry repointed in the console', async () => {
  // The case drift detection exists to catch: the key is still there, so a
  // count-based comparison would see nothing, but it now resolves elsewhere.
  const { restore } = recordFetch([liveMap('ALN', { '10.0.0.1': 'attacker-host', '10.0.0.2': 'db-server' })])
  try {
    const result = await driftDetect(driftContext([HOST_MAP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Host Map.entries')
    assert.ok(diff, `expected an entries diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.deepEqual(diff.expected, ['10.0.0.1=web-server', '10.0.0.2=db-server'])
    assert.deepEqual(diff.actual, ['10.0.0.1=attacker-host', '10.0.0.2=db-server'])
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('reference-maps driftDetect: reports an entry added in the console', async () => {
  const { restore } = recordFetch([
    liveMap('ALN', { '10.0.0.1': 'web-server', '10.0.0.2': 'db-server', '10.0.0.7': 'someone-added-this' }),
  ])
  try {
    const result = await driftDetect(driftContext([HOST_MAP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Host Map.entries')
    assert.ok(diff)
    assert.deepEqual(diff.actual, ['10.0.0.1=web-server', '10.0.0.2=db-server', '10.0.0.7=someone-added-this'])
  } finally {
    restore()
  }
})

test('reference-maps driftDetect: a map recreated with another element type is critical', async () => {
  const { restore } = recordFetch([liveMap('IP', { '10.0.0.1': 'web-server', '10.0.0.2': 'db-server' })])
  try {
    const result = await driftDetect(driftContext([HOST_MAP]))

    const diff = result.diffs.find((d) => d.field === 'Host Map.element_type')
    assert.ok(diff)
    assert.equal(diff.expected, 'ALN')
    assert.equal(diff.actual, 'IP')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('reference-maps driftDetect: an unreadable map is "could not check", never "absent"', async () => {
  // This is the distinction the whole contract rests on: a 500 must not become
  // `actual: 'absent', severity: 'critical'`, and must not let the run report a
  // bare `hasDrift: false` that clears a real outstanding drift record.
  const { restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await driftDetect(driftContext([HOST_MAP]))

    assert.deepEqual(result.diffs, [], 'a failed read is not evidence the map was deleted')
    assert.equal(result.hasDrift, false)
    assert.equal(result.checked, false, 'a run that could not look must not claim it checked')
  } finally {
    restore()
  }
})

test('reference-maps driftDetect: an unreachable console is "could not check", not "in sync"', async () => {
  const { restore } = recordFetch([transportFailure()])
  try {
    const result = await driftDetect(driftContext([HOST_MAP]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, false)
  } finally {
    restore()
  }
})

test('reference-maps driftDetect: one unreadable map does not hide drift found in another', async () => {
  const OTHER = item('Watchlist', { name: 'Watchlist', elementType: 'ALN', entries: 'keep=me' })
  const { restore } = routeFetch([
    { url: /\/reference_data\/maps\/Host%20Map$/, respond: serverError() },
    { url: /\/reference_data\/maps\/Watchlist$/, respond: notFound() },
  ])
  try {
    const result = await driftDetect(driftContext([HOST_MAP, OTHER]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['Watchlist'],
    )
    assert.equal(result.checked, false, 'the run is still only partly checked')
  } finally {
    restore()
  }
})

test('reference-maps driftDetect: an empty deployed config checks nothing and reports in sync', async () => {
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
