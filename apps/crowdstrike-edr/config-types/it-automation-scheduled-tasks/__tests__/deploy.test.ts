// deploy for it-automation-scheduled-tasks.
//
// A scheduled task decides WHEN an automation task runs and, through its host
// groups, WHERE. Its API identity is `task_id`, not a name — the canvas `name`
// is a Veltrix-side label — so every lookup, create and update here is keyed on
// task_id. The shared contract covers the pre-flight refusals; what is specific
// is the create/update split and the LIVE prior schedule that must be written
// down before an existing recurrence is overwritten.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  CREATED_WITHOUT_ID,
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  callsOfMethod,
  created,
  deployContext,
  describeCalls,
  entityPage,
  forbidden,
  idsPage,
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/it-automation\/queries\/scheduled-tasks\/v1/
const ENTITY = /\/it-automation\/entities\/scheduled-tasks\/v1/

const DESIRED_SCHEDULE = { frequency: 'Daily', interval: 1, time: '02:00' }

/**
 * One declared scheduled task. `extractScheduledTaskSpecs` reads a FLAT `fields`
 * record — `name`, `taskId`, `hostGroups`, `schedule`, `timezone`, `enabled`.
 */
const SCHEDULED = item('Nightly patch sweep', {
  name: 'nightly-patch-sweep',
  taskId: 'task-7781',
  hostGroups: 'hg-prod-1, hg-prod-2',
  schedule: JSON.stringify(DESIRED_SCHEDULE),
  timezone: 'UTC',
  enabled: true,
})

/**
 * The scheduled task as it exists in the tenant BEFORE this deploy —
 * deliberately different from the canvas in every managed field, so a rollback
 * record that captured the DESIRED schedule instead of the LIVE one fails these
 * assertions.
 */
const LIVE_SCHEDULE = {
  frequency: 'Weekly',
  interval: 3,
  time: '13:30',
  timezone: 'America/New_York',
  days_of_week: ['Sunday'],
}

const LIVE_SCHEDULED = {
  id: 'sched-live-1',
  task_id: 'task-7781',
  is_active: false,
  schedule: LIVE_SCHEDULE,
  group_ids: ['hg-legacy-9'],
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({
  label: 'it-automation-scheduled-tasks',
  handler: deploy,
  items: [SCHEDULED],
})

test('it-automation-scheduled-tasks deploy: creates a scheduled task that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'sched-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([SCHEDULED]))

    assertAuthenticatedFirst(assert, calls)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)

    const body = bodyOf(posts[0])
    assert.equal(body?.task_id, 'task-7781', 'task_id is the API identity, not the canvas name')
    assert.equal(body?.is_active, true)
    assert.deepEqual(body?.schedule, { ...DESIRED_SCHEDULE, timezone: 'UTC' })

    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'a scheduled task that did not exist must not be patched',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: does not guess at the unverified host-group target field', async () => {
  // validate.ts documents that the shape of `target` is unverified for this
  // newer collection, so deploy captures host groups without writing them. A
  // guessed shape would silently re-target the schedule at the wrong machines;
  // omitting it makes a live API that requires one reject the create loudly.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'sched-new-1' }) },
  ])
  try {
    await deploy(deployContext([SCHEDULED]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.equal(body?.target, undefined)
    assert.equal(body?.group_ids, undefined)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: records the created scheduled task so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'sched-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([SCHEDULED]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'nightly-patch-sweep')
    assert.equal(state[0].taskId, 'task-7781')
    assert.equal(state[0].existed, false)
    assert.equal(state[0].id, 'sched-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: updates a scheduled task that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sched-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_SCHEDULED]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([SCHEDULED]))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      'an existing scheduled task must not be created again',
    )

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'sched-live-1', 'the update must address the live scheduled task by its id')
    assert.equal(body?.task_id, 'task-7781')
    assert.equal(body?.is_active, true)
    assert.deepEqual(body?.schedule, { ...DESIRED_SCHEDULE, timezone: 'UTC' })
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: records the LIVE prior schedule of a task it overwrote', async () => {
  // The canvas asks for daily 02:00 UTC and active; the tenant holds a weekly
  // 13:30 New York recurrence that is switched off. Rollback restores what was
  // there, not what was wanted, so both must come from LIVE_SCHEDULED.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sched-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_SCHEDULED]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([SCHEDULED]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          name: string
          taskId: string
          existed: boolean
          id?: string
          prior?: { is_active?: boolean; schedule?: Record<string, unknown> }
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'sched-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.is_active, false)
    assert.deepEqual(prior.schedule, LIVE_SCHEDULE, 'the recorded schedule must be the LIVE one')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([SCHEDULED]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a schedule it never wrote as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sched-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_SCHEDULED]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('task is not schedulable') },
  ])
  try {
    const result = await deploy(deployContext([SCHEDULED]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /not schedulable/)
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: an invalid schedule fails before touching the tenant', async () => {
  const broken = item('Broken', {
    name: 'broken-schedule',
    taskId: 'task-9999',
    schedule: '{ "frequency": "Fortnightly" }',
    enabled: true,
  })
  const { calls, restore } = routeFetch([])
  try {
    const result = await deploy(deployContext([broken]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /invalid schedule/)
    assert.equal(calls.length, 0, 'a recurrence the handler rejects must not reach Falcon')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: keeps the rollback record of what it wrote when a later task fails', async () => {
  // The first scheduled task is created, the second is rejected. Everything the
  // deploy already changed must still come back on the failure path — a `catch`
  // that returns only `{ success: false, message }` discards it.
  const SECOND = item('Weekly inventory', {
    name: 'weekly-inventory',
    taskId: 'task-8892',
    schedule: JSON.stringify({ frequency: 'Weekly', interval: 1 }),
    enabled: true,
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'sched-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([SCHEDULED, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /after 1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the scheduled task that WAS created must still be recorded')
    assert.equal(state[0].id, 'sched-new-1')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sched-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_SCHEDULED]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([SCHEDULED]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createEntity` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // schedule now exists in the tenant with nothing recorded to delete it. What
  // is asserted is only the half that is certainly right: the deploy does not
  // claim success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([SCHEDULED]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the scheduled task was in fact created')
  } finally {
    restore()
  }
})

test('it-automation-scheduled-tasks deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
