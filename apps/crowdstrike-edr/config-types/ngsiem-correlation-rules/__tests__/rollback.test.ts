// rollback for ngsiem-correlation-rules.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that BOTH branches re-resolve the rule by name first — a
// write mints a new VERSION id, so the id deploy captured is stale — and the
// entries that must produce NO write because there is nothing safe to restore.

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

const QUERIES = /\/correlation-rules\/queries\/rules\/v1/
const ENTITY = /\/correlation-rules\/entities\/rules\/v1/

const CREATED_ENTRY = { name: 'lsass-credential-dumping', existed: false, id: 'rule-new-1' }

const UPDATED_ENTRY = {
  name: 'lsass-credential-dumping',
  existed: true,
  id: 'rule-live-1',
  prior: {
    description: 'legacy description nobody updated',
    severity: 10,
    status: 'inactive',
    search: {
      filter: '#event_simpleName=OldEventName',
      trigger_mode: 'verbose',
      outcome: 'detection',
      execution_mode: 'scheduled',
      lookback: '24h',
    },
    operation: { schedule: { definition: '@every 24h' } },
    mitre_attack: [{ tactic_id: 'TA0001' }],
  },
}

/** The live rule the re-resolution finds, at whatever its CURRENT version id is. */
function resolves(id: string) {
  return [
    { url: QUERIES, respond: idsPage([id]) },
    { url: ENTITY, method: 'GET', respond: entityPage([{ id, name: 'lsass-credential-dumping' }]) },
  ]
}

registerRollbackGuardContract({
  label: 'ngsiem-correlation-rules',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('ngsiem-correlation-rules rollback: deletes a rule this deploy created', async () => {
  const { calls, restore } = routeFetch([
    ...resolves('rule-head-7'),
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    // The RE-RESOLVED head id, not the version id deploy recorded.
    assert.match(deletes[0].url, /ids=rule-head-7/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created rule is deleted, not patched')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules rollback: makes no delete when the created rule is already gone', async () => {
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

test('ngsiem-correlation-rules rollback: restores the recorded prior values of a rule it overwrote', async () => {
  const { calls, restore } = routeFetch([
    ...resolves('rule-head-9'),
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.ok(body, 'the restore carried no JSON body')
    assert.equal(body.id, 'rule-head-9', 'the restore must address the CURRENT head version')
    assert.equal(body.name, 'lsass-credential-dumping')
    assert.equal(body.description, 'legacy description nobody updated')
    assert.equal(body.severity, 10)
    assert.equal(body.status, 'inactive', 'a rule the deploy activated must be deactivated again')
    assert.deepEqual(body.search, UPDATED_ENTRY.prior.search)
    assert.deepEqual(body.operation, UPDATED_ENTRY.prior.operation)
    assert.deepEqual(body.mitre_attack, [{ tactic_id: 'TA0001' }])
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated rule must never be deleted')
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules rollback: clears a MITRE mapping the deploy added', async () => {
  // The rule had no mapping before the deploy. Omitting mitre_attack from the
  // restore would leave the deployed mapping in place.
  const entry = { ...UPDATED_ENTRY, prior: { ...UPDATED_ENTRY.prior, mitre_attack: undefined } }
  const { calls, restore } = routeFetch([
    ...resolves('rule-head-9'),
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.deepEqual(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.mitre_attack, [])
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live rule but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the rule alone.
  const { calls, restore } = routeFetch([...resolves('rule-head-9')], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'lsass-credential-dumping', existed: true, id: 'rule-live-1' }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules rollback: writes nothing when the rule it would restore no longer exists', async () => {
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: EMPTY }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(
      writeCalls(calls).length,
      0,
      'a rule deleted in the console must not be re-created by a restore PATCH',
    )
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    ...resolves('rule-head-7'),
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

test('ngsiem-correlation-rules rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    ...resolves('rule-head-9'),
    { url: ENTITY, method: 'PATCH', respond: partialFailure('correlation rule is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored rule')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('ngsiem-correlation-rules rollback: reports how far it got when a later entry fails', async () => {
  // Each entry re-resolves its own rule, so the entity read answers with the
  // matching name in turn — an identity mismatch would make the second entry a
  // silent no-op rather than the failure this test is about.
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['rule-head-9']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: [
        entityPage([{ id: 'rule-head-9', name: 'lsass-credential-dumping' }]),
        entityPage([{ id: 'rule-head-10', name: 'suspicious-service-install' }]),
      ],
    },
    {
      url: ENTITY,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'suspicious-service-install', id: 'rule-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.ok(vendorCalls(calls).length > 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
