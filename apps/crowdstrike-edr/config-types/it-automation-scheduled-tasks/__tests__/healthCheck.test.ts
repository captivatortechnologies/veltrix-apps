// healthCheck for it-automation-scheduled-tasks.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling every crowdstrike-edr config type has in common. What is specific
// here is the second half of the check: every declared scheduled task must still
// resolve by its `task_id` identity AND — when the live resource exposes it —
// match the declared active state, reported as `scheduled-task:<name>`.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  EMPTY,
  TOKEN,
  entityPage,
  healthContext,
  idsPage,
  item,
  recordFetch,
  routeFetch,
  serverError,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerHealthCheckContract } from '../../../lib/__tests__/falconContracts'

registerHealthCheckContract({
  label: 'it-automation-scheduled-tasks',
  handler: healthCheck,
  probePath: '/it-automation/queries/scheduled-tasks/v1',
  scopePattern: /IT automation scheduled tasks: Read/,
})

const SCHEDULED = item('Nightly patch sweep', {
  name: 'nightly-patch-sweep',
  taskId: 'task-7781',
  schedule: JSON.stringify({ frequency: 'Daily', interval: 1, time: '02:00' }),
  timezone: 'UTC',
  enabled: true,
})

/** Reachability probe, then the two-call entity-adapter lookup for one task. */
const probeThenLookup = (live: Record<string, unknown> | null) =>
  live === null
    ? [TOKEN, EMPTY, EMPTY]
    : [TOKEN, EMPTY, idsPage([String(live.id)]), entityPage([live])]

test('it-automation-scheduled-tasks healthCheck: passes when every declared schedule is present and active', async () => {
  const { calls, restore } = recordFetch(
    probeThenLookup({ id: 'sched-live-1', task_id: 'task-7781', is_active: true }),
  )
  try {
    const result = await healthCheck(healthContext([SCHEDULED]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'scheduled-task:nightly-patch-sweep')
    assert.ok(check, `expected a per-schedule check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks healthCheck: fails when a declared schedule was switched off in the console', async () => {
  // An inactive schedule never runs, so "present" is not enough for this check
  // to pass — the customer would believe the sweep is happening nightly.
  const { restore } = recordFetch(
    probeThenLookup({ id: 'sched-live-1', task_id: 'task-7781', is_active: false }),
  )
  try {
    const result = await healthCheck(healthContext([SCHEDULED]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'scheduled-task:nightly-patch-sweep')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /is inactive but should be active/)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks healthCheck: fails when a declared schedule has been deleted in the tenant', async () => {
  const { calls, restore } = recordFetch(probeThenLookup(null))
  try {
    const result = await healthCheck(healthContext([SCHEDULED]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'scheduled-task:nightly-patch-sweep')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks healthCheck: does not look for schedules when the tenant is unreachable', async () => {
  // The presence check is only meaningful once reachability passed — otherwise
  // every schedule would read as "does not exist" because nothing could be read.
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
  try {
    const result = await healthCheck(healthContext([SCHEDULED]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('scheduled-task:')),
      false,
      'an unreadable tenant must not be reported as the schedule being absent',
    )
    assert.equal(
      calls.filter((c) => c.url.includes('filter=')).length,
      0,
      'no per-schedule lookup may follow a failed reachability probe',
    )
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks healthCheck: reports a failed per-schedule lookup as failed, not as absent', async () => {
  // The reachability probe succeeds and the per-schedule query then 500s. That
  // is "I could not look", and it must not pass.
  const { restore } = recordFetch([TOKEN, EMPTY, serverError('internal server error')])
  try {
    const result = await healthCheck(healthContext([SCHEDULED]))

    assert.equal(result.healthy, false)
    const check = result.checks.find((c) => c.name === 'scheduled-task:nightly-patch-sweep')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /internal server error/)
  } finally {
    restore()
  }
})
