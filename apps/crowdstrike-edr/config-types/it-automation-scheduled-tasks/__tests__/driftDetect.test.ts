// driftDetect for it-automation-scheduled-tasks.
//
// The shared contract covers the invariants: drift never writes, a deleted
// schedule is critical drift, and a 500 is never reported as the schedule being
// gone. What is specific here is the comparison itself — the recurrence keys the
// canvas declared (and ONLY those), the active flag, and the host groups that
// decide which machines the task runs on. A schedule edited in the console is
// the change this config type exists to catch.

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

const DESIRED_SCHEDULE = { frequency: 'Daily', interval: 1, time: '02:00' }

const SCHEDULED = item('Nightly patch sweep', {
  name: 'nightly-patch-sweep',
  taskId: 'task-7781',
  hostGroups: 'hg-prod-1, hg-prod-2',
  schedule: JSON.stringify(DESIRED_SCHEDULE),
  timezone: 'UTC',
  enabled: true,
})

registerDriftContract({
  label: 'it-automation-scheduled-tasks',
  handler: driftDetect,
  items: [SCHEDULED],
})

/** The live scheduled task exactly matching the canvas, overridable per field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'sched-live-1',
  task_id: 'task-7781',
  is_active: true,
  schedule: { frequency: 'Daily', interval: 1, time: '02:00', timezone: 'UTC' },
  group_ids: ['hg-prod-1', 'hg-prod-2'],
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('it-automation-scheduled-tasks driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([SCHEDULED]))

    assert.equal(result.hasDrift, false, `unexpected diffs: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks driftDetect: reports a run time moved in the Falcon console', async () => {
  // The sweep still exists and is still daily, but it now runs in the middle of
  // the working day instead of at 02:00 — exactly the silent change drift
  // detection exists to surface.
  const { restore } = recordFetch(
    lookup(live({ schedule: { frequency: 'Daily', interval: 1, time: '13:30', timezone: 'UTC' } })),
  )
  try {
    const result = await driftDetect(driftContext([SCHEDULED]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'nightly-patch-sweep.schedule.time')
    assert.ok(diff, `expected a schedule.time diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '"02:00"')
    assert.equal(diff.actual, '"13:30"')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks driftDetect: reports a recurrence changed from daily to weekly', async () => {
  const { restore } = recordFetch(
    lookup(live({ schedule: { frequency: 'Weekly', interval: 3, time: '02:00', timezone: 'UTC' } })),
  )
  try {
    const result = await driftDetect(driftContext([SCHEDULED]))

    const frequency = result.diffs.find((d) => d.field === 'nightly-patch-sweep.schedule.frequency')
    assert.ok(frequency, `expected a frequency diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(frequency.actual, '"Weekly"')
    const interval = result.diffs.find((d) => d.field === 'nightly-patch-sweep.schedule.interval')
    assert.ok(interval)
    assert.equal(interval.actual, '3')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks driftDetect: reports a timezone the live schedule no longer carries', async () => {
  const { restore } = recordFetch(
    lookup(live({ schedule: { frequency: 'Daily', interval: 1, time: '02:00' } })),
  )
  try {
    const result = await driftDetect(driftContext([SCHEDULED]))

    const diff = result.diffs.find((d) => d.field === 'nightly-patch-sweep.schedule.timezone')
    assert.ok(diff, `expected a timezone diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'not present on schedule')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks driftDetect: ignores live schedule keys the canvas never declared', async () => {
  // A key this configuration does not manage is not its drift to report.
  const { restore } = recordFetch(
    lookup(
      live({
        schedule: {
          frequency: 'Daily',
          interval: 1,
          time: '02:00',
          timezone: 'UTC',
          end_time: '2027-01-01T00:00:00Z',
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([SCHEDULED]))

    assert.equal(result.hasDrift, false, `undeclared keys drifted: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks driftDetect: reports a schedule switched off in the console', async () => {
  const { restore } = recordFetch(lookup(live({ is_active: false })))
  try {
    const result = await driftDetect(driftContext([SCHEDULED]))

    const diff = result.diffs.find((d) => d.field === 'nightly-patch-sweep.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks driftDetect: reports host groups re-targeted in the console', async () => {
  // The recurrence is unchanged but the task now runs somewhere else entirely.
  const { restore } = recordFetch(lookup(live({ group_ids: ['hg-lab-3'] })))
  try {
    const result = await driftDetect(driftContext([SCHEDULED]))

    const diff = result.diffs.find((d) => d.field === 'nightly-patch-sweep.hostGroups')
    assert.ok(diff, `expected a hostGroups diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'hg-prod-1, hg-prod-2')
    assert.equal(diff.actual, 'hg-lab-3')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks driftDetect: does not report host groups the live task never exposed', async () => {
  // The API returned no `group_ids` at all. "I could not see it" must not become
  // "it targets nothing" — deploy does not write this field either.
  const noGroups = live()
  delete (noGroups as { group_ids?: unknown }).group_ids
  const { restore } = recordFetch(lookup(noGroups))
  try {
    const result = await driftDetect(driftContext([SCHEDULED]))

    assert.equal(
      result.diffs.some((d) => d.field === 'nightly-patch-sweep.hostGroups'),
      false,
      'an unreadable target must not be reported as drift',
    )
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        is_active: false,
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([SCHEDULED]))

    const diff = result.diffs.find((d) => d.field === 'nightly-patch-sweep.enabled')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ is_active: false, modified_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([SCHEDULED]))

    const diff = result.diffs.find((d) => d.field === 'nightly-patch-sweep.enabled')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Nightly patch sweep', {
    name: 'nightly-patch-sweep',
    taskId: 'task-7781',
    hostGroups: 'hg-prod-1, hg-prod-2',
    schedule: JSON.stringify({ frequency: 'Daily', interval: 1, time: '04:00' }),
    timezone: 'UTC',
    enabled: true,
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([SCHEDULED], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
