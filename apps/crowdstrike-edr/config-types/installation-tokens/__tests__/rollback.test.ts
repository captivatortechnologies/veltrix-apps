// rollback for installation-tokens.
//
// The shared contract covers the refusals every config type has. What is
// specific here is the asymmetry the handler documents: a token this deploy
// CREATED is deleted (the true inverse), while a token it merely updated is
// always reversed with a PATCH — never a hard delete, because deleting an
// enrolment token the customer created themselves cannot be undone from here.
//
// The id rides in the `ids` query parameter on this API, not in the body.

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

const QUERIES = /\/installation-tokens\/queries\/tokens\/v1/
const ENTITY = /\/installation-tokens\/entities\/tokens\/v1/

/** The token secret the fake tenant hands back — it must never be echoed. */
const TOKEN_VALUE = 'falcon-installation-token-value-MUST-NOT-LEAK'

function leaksTokenValue(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(TOKEN_VALUE)
}

const CREATED_ENTRY = { label: 'workstation-rollout', existed: false, id: 'tok-new-1' }

const UPDATED_ENTRY = {
  label: 'workstation-rollout',
  existed: true,
  id: 'tok-live-1',
  prior: { label: 'workstation-rollout', expiresTimestamp: '2026-03-01T00:00:00Z', revoked: true },
}

registerRollbackGuardContract({
  label: 'installation-tokens',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('installation-tokens rollback: deletes a token this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['tok-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'tok-new-1', label: 'workstation-rollout', value: TOKEN_VALUE }]),
    },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=tok-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created token is deleted, not patched')
    assert.equal(leaksTokenValue(result), false, 'the token secret must not reach the rollback result')
  } finally {
    restore()
  }
})

test('installation-tokens rollback: makes no delete when the created token is already gone', async () => {
  // A concurrent delete must be a no-op, not a hard error — and never a delete
  // of whatever the listing happened to return.
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: EMPTY }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('installation-tokens rollback: restores the recorded prior label, expiry and revoke state', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=tok-live-1/, 'the id rides in the query, not the body')

    const body = bodyOf(patches[0])
    assert.equal(body?.label, 'workstation-rollout')
    assert.equal(body?.revoked, true, 'a token the deploy un-revoked must be revoked again')
    assert.equal(body?.expires_timestamp, '2026-03-01T00:00:00Z')
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated token must never be deleted')
  } finally {
    restore()
  }
})

test('installation-tokens rollback: un-revokes a token the deploy revoked', async () => {
  // The reverse direction matters just as much: leaving a customer's token
  // revoked means sensors cannot be installed at all.
  const entry = {
    label: 'workstation-rollout',
    existed: true,
    id: 'tok-live-1',
    prior: { label: 'workstation-rollout', expiresTimestamp: '', revoked: false },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.revoked, false)
  } finally {
    restore()
  }
})

test('installation-tokens rollback: omits an empty prior expiry rather than inventing one', async () => {
  // The API has no verified way to clear an expiry, so a token that never
  // expired must not be given one by the rollback.
  const entry = {
    label: 'workstation-rollout',
    existed: true,
    id: 'tok-live-1',
    prior: { label: 'workstation-rollout', expiresTimestamp: '', revoked: false },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.expires_timestamp, undefined)
  } finally {
    restore()
  }
})

test('installation-tokens rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live token but recorded no prior. Restoring an invented
  // default here could revoke a token the customer depends on.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ label: 'workstation-rollout', existed: true, id: 'tok-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('installation-tokens rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            label: 'workstation-rollout',
            existed: true,
            prior: { label: 'workstation-rollout', expiresTimestamp: '', revoked: false },
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('installation-tokens rollback: reports a rejected restore rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('installation-tokens rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('token is managed elsewhere') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored token')
    assert.match(String(result.message), /managed elsewhere/)
  } finally {
    restore()
  }
})

test('installation-tokens rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...UPDATED_ENTRY, label: 'server-rollout', id: 'tok-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
