// rollback for recon-monitoring-rules.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is undoing a rule AND its children: a created rule is deleted
// (which cascades its actions), while an updated one has the actions this deploy
// created removed, the ones it updated restored, the ones it deleted recreated,
// and only then its own mutable fields patched back.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY,
  bodyOf,
  callsOfMethod,
  describeCalls,
  entityPage,
  forbidden,
  idsPage,
  leaksSecret,
  notFound,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const RULE_QUERIES = /\/recon\/queries\/rules\/v1/
const RULE_ENTITY = /\/recon\/entities\/rules\/v1/
const ACTION_ENTITY = /\/recon\/entities\/actions\/v1/

const CREATED_ENTRY = {
  name: 'acme-leaked-credentials',
  existed: false,
  id: 'recon-new-1',
  createdActionIds: [],
  updatedActions: [],
  deletedActions: [],
}

const UPDATED_ENTRY = {
  name: 'acme-leaked-credentials',
  existed: true,
  id: 'recon-live-1',
  prior: {
    name: 'acme-leaked-credentials',
    filter: "email_domain:'legacy.example'",
    priority: 'low',
    permissions: 'private',
    breach_monitoring_enabled: false,
    substring_matching_enabled: true,
  },
  createdActionIds: [],
  updatedActions: [],
  deletedActions: [],
}

registerRollbackGuardContract({
  label: 'recon-monitoring-rules',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('recon-monitoring-rules rollback: deletes a created rule and asks for its notifications too', async () => {
  const { calls, restore } = routeFetch([
    { url: RULE_QUERIES, respond: idsPage(['recon-new-1']) },
    {
      url: RULE_ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'recon-new-1', name: 'acme-leaked-credentials' }]),
    },
    { url: RULE_ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=recon-new-1/)
    // Without this the generated notifications outlive the rule that made them.
    assert.match(deletes[0].url, /notificationsDeletionRequested=true/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created rule is deleted, not patched')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: makes no delete when the created rule is already gone', async () => {
  // A concurrent delete must be a no-op, not a hard error — and never a delete
  // of whatever the id query happened to return.
  const { calls, restore } = routeFetch([{ url: RULE_QUERIES, respond: EMPTY }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: restores the recorded prior values of a rule it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: RULE_ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.ok(body, 'the restore carried no JSON body')
    assert.equal(body.id, 'recon-live-1')
    assert.equal(body.filter, "email_domain:'legacy.example'")
    assert.equal(body.priority, 'low')
    assert.equal(body.permissions, 'private')
    assert.equal(body.breach_monitoring_enabled, false)
    assert.equal(body.substring_matching_enabled, true)
    assert.equal(body.topic, undefined, 'topic is immutable and must never be sent on a restore')
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated rule must never be deleted')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: deletes the notification actions this deploy created', async () => {
  const entry = { ...UPDATED_ENTRY, createdActionIds: ['action-new-1'] }
  const { calls, restore } = routeFetch([
    { url: ACTION_ENTITY, method: 'DELETE', respond: ok() },
    { url: RULE_ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected one action delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=action-new-1/)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: treats an already-deleted action as done rather than failing', async () => {
  const entry = { ...UPDATED_ENTRY, createdActionIds: ['action-new-1'] }
  const { restore } = routeFetch([
    { url: ACTION_ENTITY, method: 'DELETE', respond: notFound() },
    { url: RULE_ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(result.success, true, '404 on a delete is the desired end state, not an error')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: restores an action this deploy updated to its prior values', async () => {
  const entry = {
    ...UPDATED_ENTRY,
    updatedActions: [
      {
        id: 'action-live-1',
        frequency: 'daily',
        recipients: ['legacy-dl@acme.com'],
        content_format: 'standard',
      },
    ],
  }
  const { calls, restore } = routeFetch([
    { url: ACTION_ENTITY, method: 'PATCH', respond: ok() },
    { url: RULE_ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(result.success, true)
    const actionPatches = callsOfMethod(calls, 'PATCH').filter((c) => ACTION_ENTITY.test(c.url))
    assert.equal(actionPatches.length, 1, `expected one action restore, got ${describeCalls(actionPatches)}`)
    const body = bodyOf(actionPatches[0])
    assert.ok(body, 'the action restore carried no JSON body')
    assert.equal(body.id, 'action-live-1')
    assert.equal(body.frequency, 'daily')
    assert.deepEqual(body.recipients, ['legacy-dl@acme.com'])
    assert.equal(body.content_format, 'standard')
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: recreates a pre-existing action this deploy deleted', async () => {
  // The customer's own notification was removed by convergence; rollback that
  // does not put it back leaves them silently un-notified.
  const entry = {
    ...UPDATED_ENTRY,
    deletedActions: [
      {
        type: 'email',
        frequency: 'weekly',
        recipients: ['legacy-dl@acme.com'],
        contentFormat: 'standard',
      },
    ],
  }
  const { calls, restore } = routeFetch([
    { url: ACTION_ENTITY, method: 'POST', respond: ok() },
    { url: RULE_ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(result.success, true)
    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected one action recreate, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.ok(body, 'the action recreate carried no JSON body')
    assert.equal(body.rule_id, 'recon-live-1')
    const actions = body.actions as Array<Record<string, unknown>>
    assert.equal(actions[0].frequency, 'weekly')
    assert.deepEqual(actions[0].recipients, ['legacy-dl@acme.com'])
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live rule but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the rule alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'acme-leaked-credentials', existed: true, id: 'recon-live-1', createdActionIds: [] },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'acme-leaked-credentials', existed: true, prior: { priority: 'low' } },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: RULE_QUERIES, respond: idsPage(['recon-new-1']) },
    {
      url: RULE_ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'recon-new-1', name: 'acme-leaked-credentials' }]),
    },
    {
      url: RULE_ENTITY,
      method: 'DELETE',
      respond: forbidden('access denied, authorization failed'),
    },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: RULE_ENTITY, method: 'PATCH', respond: partialFailure('monitoring rule is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored rule')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('recon-monitoring-rules rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: RULE_ENTITY,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'acme-brand-impersonation', id: 'recon-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
