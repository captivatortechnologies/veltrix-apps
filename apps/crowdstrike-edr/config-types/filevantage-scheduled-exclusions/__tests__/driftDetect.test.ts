// driftDetect for filevantage-scheduled-exclusions.
//
// The shared contract covers the invariants: drift never writes, a deleted
// exclusion is critical drift, and a 500 is never reported as the exclusion
// being gone. What is specific here is that every managed field defines a period
// of deliberate blindness. A window widened, a recurrence changed from weekly to
// daily, or a process scope broadened in the console all leave FileVantage
// silently not reporting changes it was deployed to report — and the exclusion
// is still present under the same name the whole time.

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

const PROCESS = 'C:\\Windows\\System32\\wuauclt.exe'
const USER = 'NT AUTHORITY\\SYSTEM'

const EXCLUSION = item('Weekend patch window', {
  name: 'weekend-patch-window',
  policyId: 'fvp-1',
  timezone: 'Etc/UTC',
  scheduleStart: '2026-01-01T02:00:00Z',
  scheduleEnd: '2026-12-31T04:00:00Z',
  recurrence: 'weekly',
  allDay: false,
  startTime: '02:00',
  endTime: '04:00',
  weeklyDays: 'saturday, sunday',
  processes: PROCESS,
  users: USER,
})

registerDriftContract({
  label: 'filevantage-scheduled-exclusions',
  handler: driftDetect,
  items: [EXCLUSION],
})

/** The live exclusion exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'fvse-live-1',
  name: 'weekend-patch-window',
  policy_id: 'fvp-1',
  timezone: 'Etc/UTC',
  schedule_start: '2026-01-01T02:00:00Z',
  schedule_end: '2026-12-31T04:00:00Z',
  processes: PROCESS,
  users: USER,
  repeated: {
    frequency: 'weekly',
    all_day: false,
    start_time: '02:00',
    end_time: '04:00',
    weekly_days: ['saturday', 'sunday'],
  },
  ...over,
})

/** The two-call lookup: policy-wide id query, then the entities get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('filevantage-scheduled-exclusions driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: reports a schedule window moved in the console', async () => {
  const { restore } = recordFetch(lookup(live({ schedule_start: '2026-01-01T00:00:00Z' })))
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'weekend-patch-window.scheduleStart')
    assert.ok(diff, `expected a scheduleStart diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '2026-01-01T02:00:00Z')
    assert.equal(diff.actual, '2026-01-01T00:00:00Z')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: reports an end date removed, leaving the window open-ended', async () => {
  // An exclusion with no end never stops suppressing change events.
  const { restore } = recordFetch(lookup(live({ schedule_end: undefined })))
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'weekend-patch-window.scheduleEnd')
    assert.ok(diff, `expected a scheduleEnd diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '2026-12-31T04:00:00Z')
    assert.equal(diff.actual, 'open-ended')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: ignores a formatting-only difference in the schedule instant', async () => {
  const { restore } = recordFetch(lookup(live({ schedule_start: '2026-01-01T02:00:00.000Z' })))
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    assert.equal(
      result.diffs.some((d) => d.field === 'weekend-patch-window.scheduleStart'),
      false,
      `the same instant is not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: reports a timezone change, which silently shifts the window', async () => {
  const { restore } = recordFetch(lookup(live({ timezone: 'America/New_York' })))
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'weekend-patch-window.timezone')
    assert.ok(diff, `expected a timezone diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'Etc/UTC')
    assert.equal(diff.actual, 'America/New_York')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: reports a weekly window turned daily', async () => {
  const { restore } = recordFetch(lookup(live({ repeated: { frequency: 'daily', all_day: true } })))
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'weekend-patch-window.recurrence')
    assert.ok(diff, `expected a recurrence diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'weekly')
    assert.equal(diff.actual, 'daily')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: reports the recurrence removed entirely', async () => {
  const { restore } = recordFetch(lookup(live({ repeated: null })))
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'weekend-patch-window.recurrence')
    assert.ok(diff)
    assert.equal(diff.actual, 'never')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: reports weekly days extended in the console', async () => {
  // Same frequency, one more day of blindness a week.
  const { restore } = recordFetch(
    lookup(
      live({
        repeated: {
          frequency: 'weekly',
          all_day: false,
          start_time: '02:00',
          end_time: '04:00',
          weekly_days: ['saturday', 'sunday', 'friday'],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'weekend-patch-window.weeklyDays')
    assert.ok(diff, `expected a weeklyDays diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'saturday, sunday')
    assert.equal(diff.actual, 'saturday, sunday, friday')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: ignores weekly day ORDER, which Falcon does not preserve', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        repeated: {
          frequency: 'weekly',
          all_day: false,
          start_time: '02:00',
          end_time: '04:00',
          weekly_days: ['sunday', 'saturday'],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    assert.equal(result.hasDrift, false, `reordered days are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: reports a process scope widened in the console', async () => {
  // Every process added here is one whose file changes stop being reported for
  // the whole window.
  const { restore } = recordFetch(lookup(live({ processes: `${PROCESS},C:\\Temp\\anything.exe` })))
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'weekend-patch-window.processes')
    assert.ok(diff, `expected a processes diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, PROCESS)
    assert.match(String(diff.actual), /anything\.exe/)
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: reports a user scope changed in the console', async () => {
  const { restore } = recordFetch(lookup(live({ users: 'ACME\\contractor' })))
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'weekend-patch-window.users')
    assert.ok(diff, `expected a users diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, USER)
    assert.equal(diff.actual, 'ACME\\contractor')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        timezone: 'America/New_York',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'weekend-patch-window.timezone')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(
    lookup(live({ timezone: 'America/New_York', modified_by: CLIENT_ID })),
  )
  try {
    const result = await driftDetect(driftContext([EXCLUSION]))

    const diff = result.diffs.find((d) => d.field === 'weekend-patch-window.timezone')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: skips an item with no policy id rather than guessing one', async () => {
  const ORPHAN = item('No policy', {
    name: 'orphan-window',
    timezone: 'Etc/UTC',
    scheduleStart: '2026-01-01T02:00:00Z',
  })
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([ORPHAN]))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0, 'an exclusion with no parent policy cannot be looked up at all')
  } finally {
    restore()
  }
})

test('filevantage-scheduled-exclusions driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Weekend patch window', {
    name: 'weekend-patch-window',
    policyId: 'fvp-1',
    timezone: 'America/New_York',
    scheduleStart: '2026-06-01T02:00:00Z',
    recurrence: 'daily',
    processes: PROCESS,
    users: USER,
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([EXCLUSION], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
