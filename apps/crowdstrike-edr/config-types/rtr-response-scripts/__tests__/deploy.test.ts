// deploy for rtr-response-scripts.
//
// An RTR custom script runs on a customer's endpoints with the highest privilege
// the sensor has, so the SCRIPT BODY this deploy uploads is the payload that
// executes. Both create and update are multipart/form-data ONLY — `bodyOf()`
// returns null for those calls and the body rides in the `content` form field,
// which is why every assertion below reads the form rather than a JSON body.
//
// The update path is the one that silently overwrites: it must PATCH the live
// script by its id rather than POST a second script with the same name.

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
  formField,
  idsPage,
  item,
  leaksSecret,
  ok,
  partialFailure,
  routeFetch,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDeployGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/real-time-response\/queries\/scripts\/v1/
const ENTITY = /\/real-time-response\/entities\/scripts\/v1/

const SCRIPT_BODY = 'Get-Process | Export-Csv -Path /tmp/procs.csv -NoTypeInformation'

/**
 * One declared script. `extractScriptSpecs` reads a FLAT `fields` record —
 * `name`, `description`, `platform`, `permissionType`, `content`,
 * `commentsForAuditLog`.
 */
const SCRIPT = item('Collect forensics', {
  name: 'collect-forensics',
  description: 'Collects volatile forensic artefacts',
  platform: 'windows',
  permissionType: 'group',
  content: SCRIPT_BODY,
  commentsForAuditLog: 'Reviewed by IR',
})

/**
 * The script as it exists in the tenant BEFORE this deploy — deliberately
 * different from the canvas in every managed field, so a rollback record that
 * captured the DESIRED values instead of the LIVE ones fails these assertions.
 */
const LIVE_SCRIPT = {
  id: 'scr-live-1',
  name: 'collect-forensics',
  description: 'legacy description nobody updated',
  platform: ['linux'],
  permission_type: 'private',
  content: 'echo legacy',
  modified_by: 'alice@acme.com',
  modified_timestamp: '2026-01-04T10:00:00Z',
}

registerDeployGuardContract({ label: 'rtr-response-scripts', handler: deploy, items: [SCRIPT] })

test('rtr-response-scripts deploy: uploads the declared body for a script that does not exist yet', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'scr-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([SCRIPT]))

    assertAuthenticatedFirst(assert, calls)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one create, got ${describeCalls(posts)}`)

    // Multipart: the JSON body is empty and fetch derives the Content-Type.
    assert.equal(bodyOf(posts[0]), null, 'the create is multipart, not JSON')
    assert.equal(posts[0].contentType, null, 'fetch must derive multipart/form-data + boundary')

    assert.equal(formField(posts[0], 'name'), 'collect-forensics')
    assert.equal(formField(posts[0], 'description'), 'Collects volatile forensic artefacts')
    assert.equal(formField(posts[0], 'platform'), 'windows')
    assert.equal(formField(posts[0], 'permission_type'), 'group')
    assert.equal(
      formField(posts[0], 'content'),
      SCRIPT_BODY,
      'the script body must be exactly what the canvas declared',
    )
    assert.equal(formField(posts[0], 'comments_for_audit_log'), 'Reviewed by IR')

    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a script that did not exist must not be patched')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: stamps its own audit comment when the canvas declared none', async () => {
  const noComment = item('Collect forensics', {
    name: 'collect-forensics',
    description: 'Collects volatile forensic artefacts',
    platform: 'windows',
    permissionType: 'group',
    content: SCRIPT_BODY,
  })
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'scr-new-1' }) },
  ])
  try {
    await deploy(deployContext([noComment]))

    assert.match(
      String(formField(callsOfMethod(calls, 'POST')[0], 'comments_for_audit_log')),
      /Managed by Veltrix/,
    )
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: records the created script so rollback can delete it', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: created({ id: 'scr-new-1' }) },
  ])
  try {
    const result = await deploy(deployContext([SCRIPT]))

    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'deploy recorded no rollback state at all')
    assert.equal(state.length, 1)
    assert.equal(state[0].name, 'collect-forensics')
    assert.equal(state[0].existed, false, 'a script this deploy created is not pre-existing')
    assert.equal(state[0].id, 'scr-new-1', 'without the new id rollback cannot delete what it created')
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: updates the existing script in place rather than creating a duplicate', async () => {
  // Two scripts with the same name in one tenant is the failure mode here: RTR
  // operators would pick one at random, and rollback would restore neither.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['scr-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_SCRIPT]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([SCRIPT]))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'an existing script must not be created again')

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one update, got ${describeCalls(patches)}`)
    assert.equal(formField(patches[0], 'id'), 'scr-live-1', 'the update must address the live script by id')
    assert.equal(formField(patches[0], 'name'), 'collect-forensics')
    assert.equal(formField(patches[0], 'platform'), 'windows')
    assert.equal(formField(patches[0], 'permission_type'), 'group')
    assert.equal(
      formField(patches[0], 'content'),
      SCRIPT_BODY,
      'the replacement body must be exactly what the canvas declared',
    )
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: records the LIVE prior values of a script it overwrote', async () => {
  // The canvas asks for a windows/group script; the tenant holds a linux/private
  // one with a different body. Rollback restores what was there, not what was
  // wanted, so every one of these must come from LIVE_SCRIPT.
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['scr-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_SCRIPT]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([SCRIPT]))

    const state = (
      result.rollbackData as {
        previousState?: Array<{
          name: string
          existed: boolean
          id?: string
          prior?: {
            description?: string
            platform?: string | string[]
            permission_type?: string
            content?: string
          }
        }>
      }
    )?.previousState
    assert.ok(state, 'deploy recorded no rollback state')
    assert.equal(state[0].existed, true)
    assert.equal(state[0].id, 'scr-live-1')

    const prior = state[0].prior
    assert.ok(prior, 'an update with no recorded prior cannot be rolled back')
    assert.equal(prior.description, 'legacy description nobody updated')
    assert.deepEqual(prior.platform, ['linux'])
    assert.equal(prior.permission_type, 'private')
    assert.equal(prior.content, 'echo legacy', 'the prior script body is what makes rollback possible')
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: reports failure rather than throwing when the upload is rejected', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await deploy(deployContext([SCRIPT]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: treats HTTP 200 with a populated errors[] as a failure', async () => {
  // Falcon returns partial failures INSIDE a 200 envelope. A handler that reads
  // `res.ok` alone reports a script it never uploaded as deployed.
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: partialFailure('script name already in use') },
  ])
  try {
    const result = await deploy(deployContext([SCRIPT]))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a success')
    assert.match(String(result.message), /already in use/)
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: treats a 200 errors[] on the UPDATE path as a failure too', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['scr-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_SCRIPT]) },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('script is locked by another user') },
  ])
  try {
    const result = await deploy(deployContext([SCRIPT]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /locked by another user/)
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: keeps the rollback record of what it wrote when a later script fails', async () => {
  // The first script is uploaded, the second is rejected. Everything the deploy
  // already changed must still come back on the failure path — a `catch` that
  // returns only `{ success: false, message }` discards it.
  const SECOND = item('Isolate host', {
    name: 'isolate-host',
    description: 'Network containment helper',
    platform: 'windows',
    permissionType: 'private',
    content: 'Stop-Service -Name RemoteRegistry',
  })
  const { restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    {
      url: ENTITY,
      method: 'POST',
      respond: [created({ id: 'scr-new-1' }), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const result = await deploy(deployContext([SCRIPT, SECOND]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /after 1 of 2/)
    const state = (result.rollbackData as { previousState?: Array<Record<string, unknown>> })
      ?.previousState
    assert.ok(state, 'the failure path discarded the rollback state deploy had captured')
    assert.equal(state.length, 1, 'the script that WAS uploaded must still be recorded')
    assert.equal(state[0].id, 'scr-new-1')
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: never puts the token or the client secret in its result', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['scr-live-1']) },
    { url: ENTITY, method: 'GET', respond: entityPage([LIVE_SCRIPT]) },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([SCRIPT]))

    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false, 'message, artifacts or rollbackData carried a secret')
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: a create that returns no id is not reported as a success', async () => {
  // DEFECT (reported, not blessed): `createScript` throws here AFTER the upload
  // succeeded, and `rollbackState.push` only runs on the line below it — so the
  // script is live in the tenant with nothing recorded to delete it. What is
  // asserted is only the half that is certainly right: the deploy does not claim
  // success. The rollback record it fails to keep is NOT asserted.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: EMPTY },
    { url: ENTITY, method: 'POST', respond: CREATED_WITHOUT_ID },
  ])
  try {
    const result = await deploy(deployContext([SCRIPT]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /returned no id/i)
    assert.equal(callsOfMethod(calls, 'POST').length, 1, 'the script was in fact uploaded')
  } finally {
    restore()
  }
})

test('rtr-response-scripts deploy: an empty canvas deploys nothing and touches nothing', async () => {
  const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0, 'nothing declared means no request at all, not even a token')
  } finally {
    restore()
  }
})
