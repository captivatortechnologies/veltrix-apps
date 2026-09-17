// driftDetect for ngsiem-correlation-rules.
//
// The shared contract covers the invariants: drift never writes, a deleted rule
// is critical drift, and a 500 is never reported as the rule being gone. What is
// specific here is the comparison itself — and the two fields that decide
// whether this rule ever fires: the CQL search and the active/inactive status.
// Both are reported as CRITICAL because a rule edited to match nothing, or
// switched off in the console, is a detection that silently stopped.

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

const RULE = item('LSASS credential dumping', {
  name: 'lsass-credential-dumping',
  description: 'Raises a detection on LSASS memory access',
  search: '#event_simpleName=ProcessRollup2 | ImageFileName=*lsass.exe*',
  severity: 'high',
  frequency: '15m',
  triggerMode: 'summary',
  mitreTactic: 'TA0006',
  mitreTechnique: 'T1003',
  status: 'active',
  createCase: true,
  publish: false,
})

registerDriftContract({ label: 'ngsiem-correlation-rules', handler: driftDetect, items: [RULE] })

/** The live rule exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'rule-live-1',
  name: 'lsass-credential-dumping',
  description: 'Raises a detection on LSASS memory access',
  severity: 70,
  status: 'active',
  search: {
    filter: '#event_simpleName=ProcessRollup2 | ImageFileName=*lsass.exe*',
    trigger_mode: 'summary',
    outcome: 'case',
    execution_mode: 'scheduled',
    lookback: '15m',
  },
  operation: { schedule: { definition: '@every 15m' } },
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('ngsiem-correlation-rules driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules driftDetect: reports a CQL search edited in the Falcon console', async () => {
  // The query IS the detection. A search narrowed by hand stops the rule firing
  // on everything it was deployed to catch, with no other visible symptom.
  const { restore } = recordFetch(
    lookup(live({ search: { filter: '#event_simpleName=ProcessRollup2 | ComputerName=TESTBOX' } })),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'lsass-credential-dumping.search')
    assert.ok(diff, `expected a search diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '#event_simpleName=ProcessRollup2 | ImageFileName=*lsass.exe*')
    assert.equal(diff.actual, '#event_simpleName=ProcessRollup2 | ComputerName=TESTBOX')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules driftDetect: reports a rule switched off in the console', async () => {
  // An inactive rule raises no detections at all.
  const { restore } = recordFetch(lookup(live({ status: 'inactive' })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'lsass-credential-dumping.status')
    assert.ok(diff, `expected a status diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'active')
    assert.equal(diff.actual, 'inactive')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules driftDetect: reports a severity downgraded in the console', async () => {
  const { restore } = recordFetch(lookup(live({ severity: 30 })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'lsass-credential-dumping.severity')
    assert.ok(diff, `expected a severity diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'high')
    // Reported as the named level, not the int32 the API stores.
    assert.equal(diff.actual, 'low')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules driftDetect: reports a schedule slowed down in the console', async () => {
  const { restore } = recordFetch(
    lookup(live({ operation: { schedule: { definition: '@every 24h' } } })),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'lsass-credential-dumping.frequency')
    assert.ok(diff, `expected a frequency diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '15m')
    assert.equal(diff.actual, '24h', 'the "@every " prefix is not part of the cadence')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules driftDetect: reports case creation and trigger mode changed in the console', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        search: {
          filter: '#event_simpleName=ProcessRollup2 | ImageFileName=*lsass.exe*',
          trigger_mode: 'verbose',
          outcome: 'detection',
          execution_mode: 'scheduled',
          lookback: '15m',
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const createCase = result.diffs.find((d) => d.field === 'lsass-credential-dumping.createCase')
    assert.ok(createCase, `expected a createCase diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(createCase.expected, true)
    assert.equal(createCase.actual, false)

    const trigger = result.diffs.find((d) => d.field === 'lsass-credential-dumping.triggerMode')
    assert.ok(trigger)
    assert.equal(trigger.actual, 'verbose')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        status: 'inactive',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'lsass-credential-dumping.status')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ status: 'inactive', modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'lsass-credential-dumping.status')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('LSASS credential dumping', {
    ...(RULE.fields as Record<string, unknown>),
    severity: 'critical',
    status: 'inactive',
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([RULE], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
