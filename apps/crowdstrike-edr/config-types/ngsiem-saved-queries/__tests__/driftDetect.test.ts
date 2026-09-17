// driftDetect for ngsiem-saved-queries.
//
// The shared contract covers the invariants: drift never writes, a deleted query
// is critical drift, and a 500 is never reported as the query being gone. What
// is specific here is the comparison — above all the CQL itself, which is what
// the saved query is: a query edited in the console returns different results
// to everyone who runs it, so it is reported as CRITICAL.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  entityPage,
  idsPage,
  item,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const SAVED_QUERY = item('Failed logons by host', {
  name: 'failed-logons-by-host',
  description: 'Counts failed interactive logons per host',
  query: '#event_simpleName=UserLogonFailed | groupBy(ComputerName)',
  timeRange: '24h',
  shared: true,
})

registerDriftContract({
  label: 'ngsiem-saved-queries',
  handler: driftDetect,
  items: [SAVED_QUERY],
})

/** The live saved query exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'sq-live-1',
  name: 'failed-logons-by-host',
  description: 'Counts failed interactive logons per host',
  query: '#event_simpleName=UserLogonFailed | groupBy(ComputerName)',
  time_range: '24h',
  shared: true,
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('ngsiem-saved-queries driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([SAVED_QUERY]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries driftDetect: reports a CQL query edited in the console', async () => {
  const { restore } = recordFetch(
    lookup(live({ query: '#event_simpleName=UserLogonSuccess | groupBy(ComputerName)' })),
  )
  try {
    const result = await driftDetect(driftContext([SAVED_QUERY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'failed-logons-by-host.query')
    assert.ok(diff, `expected a query diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '#event_simpleName=UserLogonFailed | groupBy(ComputerName)')
    assert.equal(diff.actual, '#event_simpleName=UserLogonSuccess | groupBy(ComputerName)')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries driftDetect: ignores surrounding whitespace, which the API may normalize', async () => {
  const { restore } = recordFetch(
    lookup(live({ query: '  #event_simpleName=UserLogonFailed | groupBy(ComputerName)  ' })),
  )
  try {
    const result = await driftDetect(driftContext([SAVED_QUERY]))

    assert.equal(
      result.diffs.some((d) => d.field === 'failed-logons-by-host.query'),
      false,
      `trimmed whitespace is not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries driftDetect: reports a time range widened in the console', async () => {
  const { restore } = recordFetch(lookup(live({ time_range: '7d' })))
  try {
    const result = await driftDetect(driftContext([SAVED_QUERY]))

    const diff = result.diffs.find((d) => d.field === 'failed-logons-by-host.timeRange')
    assert.ok(diff, `expected a timeRange diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '24h')
    assert.equal(diff.actual, '7d')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries driftDetect: reports a query un-shared in the console', async () => {
  const { restore } = recordFetch(lookup(live({ shared: false })))
  try {
    const result = await driftDetect(driftContext([SAVED_QUERY]))

    const diff = result.diffs.find((d) => d.field === 'failed-logons-by-host.shared')
    assert.ok(diff, `expected a shared diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries driftDetect: reads the sharing flag from either field name', async () => {
  // The template representation is not fully documented — `is_shared` is
  // accepted as an alias so an unexpected field name is not permanent drift.
  const { restore } = recordFetch(lookup(live({ shared: undefined, is_shared: true })))
  try {
    const result = await driftDetect(driftContext([SAVED_QUERY]))

    assert.equal(
      result.diffs.some((d) => d.field === 'failed-logons-by-host.shared'),
      false,
      `is_shared was not read: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries driftDetect: leaves an undeclared time range unmanaged', async () => {
  // A query whose canvas declares no time range does not own the live one.
  const noRange = item('Failed logons by host', {
    name: 'failed-logons-by-host',
    description: 'Counts failed interactive logons per host',
    query: '#event_simpleName=UserLogonFailed | groupBy(ComputerName)',
    shared: true,
  })
  const { restore } = recordFetch(lookup(live({ time_range: '30d' })))
  try {
    const result = await driftDetect(driftContext([noRange]))

    assert.equal(
      result.diffs.some((d) => d.field === 'failed-logons-by-host.timeRange'),
      false,
      'an undeclared time range must not drift',
    )
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        query: '#event_simpleName=Something',
        updated_by: 'alice@acme.com',
        updated_at: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([SAVED_QUERY]))

    const diff = result.diffs.find((d) => d.field === 'failed-logons-by-host.query')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(
    lookup(live({ query: '#event_simpleName=Something', updated_by: CLIENT_ID })),
  )
  try {
    const result = await driftDetect(driftContext([SAVED_QUERY]))

    const diff = result.diffs.find((d) => d.field === 'failed-logons-by-host.query')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('ngsiem-saved-queries driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Failed logons by host', {
    name: 'failed-logons-by-host',
    description: 'Counts failed interactive logons per host',
    query: '#event_simpleName=SomethingElse',
    timeRange: '7d',
    shared: false,
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([SAVED_QUERY], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
