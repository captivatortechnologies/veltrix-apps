// deploy for it-automation-tasks.
//
// An IT automation task carries the osquery or the remediation SCRIPT that runs
// on a customer's endpoints, so the body this deploy uploads is the payload that
// executes. The shared contract covers the pre-flight refusals; what is specific
// here is the create/update split, the task_type → content mapping (query →
// os_query, remediation → remediations.<platform>.content) and the live prior
// values that must be written down before an existing task is overwritten.

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

const QUERIES = /\/it-automation\/queries\/tasks\/v1/
const ENTITY = /\/it-automation\/entities\/tasks\/v1/

const SCRIPT_BODY = '#!/bin/sh\nrm -rf /tmp/stale/*'

/**
 * One declared remediation task. `extractITTaskSpecs` reads a FLAT `fields`
 * record — `name`, `description`, `taskType`, `platforms`, `content`,
 * `parameters`.
 */
const TASK = item('Clear stale temp files', {
  name: 'clear-stale-temp',
  description: 'Removes stale temp files older than 30 days',
  taskType: 'remediation',
  platforms: 'windows, linux',
  content: SCRIPT_BODY,
  parameters: JSON.stringify([{ key: 'maxAgeDays', input_type: 'number' }]),
})

/**
 * The task as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_TASK = {
  id: 'task-live-1',
  name: 'clear-stale-temp',
  description: 'legacy description nobody updated',
  task_type: 'query',
  os_query: 'SELECT name FROM processes',
  remediations: {
    windows: { content: 'Remove-Item -Path /tmp/legacy -Recurse' },
    linux: { content: 'rm -rf /var/tmp/old' },
  },
  task_parameters: [{ key: 'legacyParam' }],
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'it-automation-tasks', handler: deploy, items: [TASK] })

test('it-automation-tasks deploy: creates a task that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'task-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([TASK]))

    assertAuthenticatedFirst(assert, calls)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)

    const body = bodyOf(posts[0])
    assert.equal(body?.name, 'clear-stale-temp')
    assert.equal(body?.description, 'Removes stale temp files older than 30 days')
    assert.equal(body?.task_type, 'remediation')
    // The script that will run on every targeted endpoint — verbatim, per platform.
    assert.deepEqual(body?.remediations, {
      windows: { content: SCRIPT_BODY },
      linux: { content: SCRIPT_BODY },
    })
    assert.deepEqual(body?.task_parameters, [{ key: 'maxAgeDays', input_type: 'number' }])

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a task that did not exist must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: sends a query task as os_query rather than a remediation', async () => {
  // The two task types write DIFFERENT fields; sending a query as a remediation
  // would ship a read-only osquery as a script that changes the host.
  const query = item('Running processes', {
    name: 'running-processes',
    taskType: 'query',
    platforms: 'windows',
    content: 'SELECT name FROM processes',
  })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'task-new-2' }) },
  ])
  try {
    await deploy(deployContext([query]))

    const body = bodyOf(callsOfMethod(calls, 'POST')[0])
    assert.equal(body?.task_type, 'query')
    assert.equal(body?.os_query, 'SELECT name FROM processes')
    assert.equal(body?.remediations, undefined, 'a query task must not ship a remediation script')
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: records the created task so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'task-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([TASK]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'clear-stale-temp')
    assert.equal(state[0].existed, false, 'a task this deploy created is not pre-existing')
    assert.equal(state[0].id, 'task-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: updates a task that already exists, carrying its id', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['task-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_TASK]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([TASK]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing task must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'task-live-1', 'the update must address the live task by its id')
    assert.equal(body?.task_type, 'remediation')
    assert.deepEqual(body?.remediations, {
      windows: { content: SCRIPT_BODY },
      linux: { content: SCRIPT_BODY },
    })
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: records the LIVE prior values of a task it overwrote', async () => {
  // The canvas asks for a remediation script; the tenant holds a query task with
  // a different body and a different parameter. Rollback restores what was
  // there, not what was wanted, so every one of these must come from LIVE_TASK.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['task-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_TASK]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([TASK]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          name: string
          existed: boolean
          id?: string
          prior?: {
            description?: string
            task_type?: string
            os_query?: string
            remediations?: Record<string, { content?: string } | undefined>
            task_parameters?: Array<Record<string, unknown>>
          }
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'task-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.equal(prior.task_type, 'query')
    assert.equal(prior.os_query, 'SELECT name FROM processes')
    assert.deepEqual(prior.remediations, LIVE_TASK.remediations)
    assert.deepEqual(prior.task_parameters, [{ key: 'legacyParam' }])
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([TASK]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a script it never uploaded as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['task-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_TASK]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('task is locked by another user') },
  ])
  try {
    const result = await deploy(deployContext([TASK]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /locked by another user/)
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: invalid parameters fail before touching the tenant', async () => {
  const broken = item('Broken', {
    name: 'broken-task',
    taskType: 'query',
    platforms: 'windows',
    content: 'SELECT 1',
    parameters: '{ "key": "notAnArray" }',
  })
  const { calls, restore } = routeFetch([])
  try {
    const result = await deploy(deployContext([broken]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /invalid parameters/)
    assert.equal(calls.length, 0, 'parameters the handler cannot parse must not reach Falcon')
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: keeps the rollback record of what it wrote when a later task fails', async () => {
  // The first task is created, the second is rejected. Everything the deploy
  // already changed must still come back on the failure path — a `catch` that
  // returns only `{ success: false, message }` discards it.
  const SECOND = item('Collect inventory', {
    name: 'collect-inventory',
    taskType: 'query',
    platforms: 'linux',
    content: 'SELECT * FROM os_version',
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'task-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([TASK, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /after 1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the task that WAS created must still be recorded')
    assert.equal(state[0].id, 'task-new-1')
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['task-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_TASK]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([TASK]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createEntity` throws here AFTER the POST
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // task now exists in the tenant with nothing recorded to delete it. What is
  // asserted is only the half that is certainly right: the deploy does not claim
  // success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([TASK]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the task was in fact created')
  } finally {
    restore()
  }
})

test('it-automation-tasks deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
