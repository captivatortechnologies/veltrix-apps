// rollback for cloud-compliance-controls.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that restoring a control is TWO writes — the control's own
// fields and its rule assignments, which do not live on the control entity — and
// that a created control is deleted by the uuid captured at create rather than
// by whatever the query endpoint returns.

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

const CONTROL_QUERIES = /\/cloud-policies\/queries\/compliance\/controls\/v1/
const CONTROL_ENTITY = /\/cloud-policies\/entities\/compliance\/controls\/v1/
const ASSIGNMENTS = /\/cloud-policies\/entities\/compliance\/control-rule-assignments\/v1/

const CREATED_ENTRY = {
  name: 'Require MFA on console access',
  frameworkId: 'fw-live-1',
  section: 'Access Control',
  existed: false,
  uuid: 'ctl-new-1',
}

const UPDATED_ENTRY = {
  name: 'Require MFA on console access',
  frameworkId: 'fw-live-1',
  section: 'Access Control',
  existed: true,
  uuid: 'ctl-live-1',
  prior: { description: 'legacy description nobody updated', ruleIds: ['rule-legacy'] },
}

const LIVE_CONTROL = {
  uuid: 'ctl-new-1',
  name: 'Require MFA on console access',
  section_name: 'Access Control',
  security_framework: [{ uuid: 'fw-live-1', name: 'ACME Cloud Baseline' }],
}

registerRollbackGuardContract({
  label: 'cloud-compliance-controls',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('cloud-compliance-controls rollback: deletes a control this deploy created, by the uuid it captured', async () => {
  // A just-created control may not be visible on the query endpoint yet, so
  // re-resolving it by name first could leak it. The captured uuid is used
  // directly, which means no lookup call at all.
  const { calls, restore } = routeFetch([{ url: CONTROL_ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=ctl-new-1/)
    assert.equal(vendorCalls(calls).length, 1, 'the captured uuid needs no lookup')
  } finally {
    restore()
  }
})

test('cloud-compliance-controls rollback: falls back to a name lookup when no uuid was captured', async () => {
  const { calls, restore } = routeFetch([
    { url: CONTROL_QUERIES, respond: idsPage(['ctl-new-1']) },
    { url: CONTROL_ENTITY, method: 'GET', respond: entityPage([LIVE_CONTROL]) },
    { url: CONTROL_ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const { uuid: _uuid, ...withoutUuid } = CREATED_ENTRY
    const result = await rollback(rollbackContext({ previousState: [withoutUuid] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1)
    assert.match(deletes[0].url, /ids=ctl-new-1/)
  } finally {
    restore()
  }
})

test('cloud-compliance-controls rollback: makes no delete when a created control cannot be resolved', async () => {
  // A concurrent delete must be a no-op, not a hard error — and never a delete
  // of whatever the id query happened to return.
  const { calls, restore } = routeFetch([{ url: CONTROL_QUERIES, respond: EMPTY }])
  try {
    const { uuid: _uuid, ...withoutUuid } = CREATED_ENTRY
    const result = await rollback(rollbackContext({ previousState: [withoutUuid] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-compliance-controls rollback: restores the recorded prior description and rule assignments', async () => {
  const { calls, restore } = routeFetch([
    { url: CONTROL_ENTITY, method: 'PATCH', respond: ok() },
    { url: ASSIGNMENTS, method: 'PUT', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)

    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=ctl-live-1/)
    assert.equal(bodyOf(patches[0])?.description, 'legacy description nobody updated')

    const puts = callsOfMethod(calls, 'PUT')
    assert.equal(puts.length, 1, 'the prior rule assignments must be restored too')
    assert.match(puts[0].url, /ids=ctl-live-1/)
    assert.deepEqual(bodyOf(puts[0])?.rule_ids, ['rule-legacy'])

    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'a control that existed before the deploy must never be deleted',
    )
  } finally {
    restore()
  }
})

test('cloud-compliance-controls rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live control but recorded no prior body. Restoring an
  // invented default here — above all an empty rule set — is strictly worse than
  // leaving the control alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const { prior: _prior, ...withoutPrior } = UPDATED_ENTRY
    await rollback(rollbackContext({ previousState: [withoutPrior] }))

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-compliance-controls rollback: writes nothing for an updated entry whose uuid was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const { uuid: _uuid, ...withoutUuid } = UPDATED_ENTRY
    await rollback(rollbackContext({ previousState: [withoutUuid] }))

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-compliance-controls rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: CONTROL_ENTITY, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
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

test('cloud-compliance-controls rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: CONTROL_ENTITY, method: 'PATCH', respond: partialFailure('control is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored control')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('cloud-compliance-controls rollback: reports how far it got when a later entry fails', async () => {
  const { restore } = routeFetch([
    { url: CONTROL_ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
    { url: ASSIGNMENTS, method: 'PUT', respond: ok() },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'Retain cloud audit logs', uuid: 'ctl-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
  } finally {
    restore()
  }
})
