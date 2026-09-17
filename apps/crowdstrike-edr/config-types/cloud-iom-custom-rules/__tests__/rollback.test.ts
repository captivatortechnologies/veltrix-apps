// rollback for cloud-iom-custom-rules.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch back what it overwrote — and above all the entries that
// must produce NO write because there is nothing safe to restore.

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
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/cloud-policies\/queries\/rules\/v1/
const ENTITY = /\/cloud-policies\/entities\/rules\/v1/

const CREATED_ENTRY = { name: 'block-public-s3', existed: false, id: 'rule-new-1' }

const UPDATED_ENTRY = {
  name: 'block-public-s3',
  existed: true,
  id: 'rule-live-1',
  prior: {
    description: 'legacy description nobody updated',
    cloud_provider: 'azure',
    resource_type: 'Microsoft.Storage/storageAccounts',
    severity: 'informational',
    logic: 'package legacy\ndeny { false }',
    controls: [{ authority: 'NIST', code: 'AC-2' }],
    parent_rule_id: 'parent-legacy-1',
  },
}

registerRollbackGuardContract({
  label: 'cloud-iom-custom-rules',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('cloud-iom-custom-rules rollback: deletes a rule this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['rule-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'rule-new-1', name: 'block-public-s3' }]),
    },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=rule-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created rule is deleted, not patched')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules rollback: makes no delete when the created rule is already gone', async () => {
  // A concurrent delete must be a no-op, not a hard error — and never a delete
  // of whatever the id query happened to return.
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: EMPTY }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules rollback: restores the recorded prior values of a rule it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'rule-live-1')
    assert.equal(body?.name, 'block-public-s3')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(body?.cloud_provider, 'azure')
    assert.equal(body?.resource_type, 'Microsoft.Storage/storageAccounts')
    assert.equal(body?.severity, 'informational')
    assert.equal(body?.logic, 'package legacy\ndeny { false }')
    assert.equal(body?.parent_rule_id, 'parent-legacy-1')
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated rule must never be deleted')
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules rollback: clears compliance controls the deploy added', async () => {
  // Controls are always re-sent, so a compliance pair the deployment attached is
  // actually removed rather than left reporting against a framework the tenant
  // never opted into.
  const entry = {
    name: 'block-public-s3',
    existed: true,
    id: 'rule-live-1',
    prior: { severity: 'informational', controls: [] },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.deepEqual(body?.controls, [])
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live rule but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the rule alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'block-public-s3', existed: true, id: 'rule-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'block-public-s3', existed: true, prior: { severity: 'informational', controls: [] } },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['rule-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'rule-new-1', name: 'block-public-s3' }]),
    },
    { url: ENTITY, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
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

test('cloud-iom-custom-rules rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('rule is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored rule')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('cloud-iom-custom-rules rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'block-open-sg', id: 'rule-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
