// rollback for cloud-registry-connections.
//
// The shared contract covers the refusals every config type has. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch back the non-secret fields it overwrote — plus the
// entries that must produce NO write. The credential is deliberately NOT
// restorable (it is write-only and was never read back), so the restore body
// must carry no credential at all rather than an invented or stale one.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY,
  bodyOf,
  callsOfMethod,
  describeCalls,
  forbidden,
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

const ENTITY = /\/container-security\/entities\/registries\/v1/

/** See deploy.test.ts — the shared fake models Falcon's secrets, not a registry's. */
const REGISTRY_SECRET = 'registry-password-MUST-NOT-LEAK'

function leaksRegistrySecret(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(REGISTRY_SECRET)
}

const CREATED_ENTRY = { name: 'prod-harbor', existed: false, id: 'reg-new-1' }

const UPDATED_ENTRY = {
  name: 'prod-harbor',
  existed: true,
  id: 'reg-live-1',
  prior: {
    type: 'artifactory',
    url: 'harbor-old.acme.internal',
    url_uniqueness_key: 'prod-harbor-legacy',
    user_defined_alias: 'prod-harbor',
    state: 'paused',
    scan_interval: 168,
  },
}

registerRollbackGuardContract({
  label: 'cloud-registry-connections',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('cloud-registry-connections rollback: deletes a registry this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=reg-new-1/)
    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'a created registry is deleted, not patched',
    )
  } finally {
    restore()
  }
})

test('cloud-registry-connections rollback: treats a 404 on the delete as already done', async () => {
  // "Gone" is the desired end state. Failing the rollback because someone
  // removed the connection first would leave an operator chasing a phantom.
  const { restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('cloud-registry-connections rollback: writes nothing for a created entry whose id was never captured', async () => {
  // Nothing identifies what to delete. Deleting by alias would be a guess at
  // another tenant object.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ name: 'prod-harbor', existed: false }] }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-registry-connections rollback: restores the recorded prior non-secret values', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /id=reg-live-1/, 'the restore must address the registry by id')

    const body = bodyOf(patches[0])
    assert.equal(body?.type, 'artifactory')
    assert.equal(body?.url, 'harbor-old.acme.internal')
    assert.equal(body?.url_uniqueness_key, 'prod-harbor-legacy')
    assert.equal(body?.user_defined_alias, 'prod-harbor')
    assert.equal(body?.state, 'paused')
    assert.equal(body?.scan_interval, 168)
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'an updated registry must never be deleted',
    )
  } finally {
    restore()
  }
})

test('cloud-registry-connections rollback: never sends a credential in the restore body', async () => {
  // The secret was never read back, so there is nothing to restore. Sending an
  // empty credential block would wipe the working one and stop every scan.
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0]) ?? {}
    assert.equal('credential' in body, false)
    assert.equal(leaksRegistrySecret(result), false)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-registry-connections rollback: says out loud that the credential was not restored', async () => {
  // The registry keeps whatever secret the deployment set. An operator who is
  // not told that will believe the rollback was complete.
  const { restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Credentials are not restored/i)
  } finally {
    restore()
  }
})

test('cloud-registry-connections rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live registry but recorded no prior body. Patching an
  // empty object here would blank the connection's URL and type.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'prod-harbor', existed: true, id: 'reg-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-registry-connections rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'prod-harbor', existed: true, prior: { url: 'harbor-old.acme.internal' } },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-registry-connections rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksRegistrySecret(result), false)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-registry-connections rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('registry is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored registry')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('cloud-registry-connections rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'lab-quay', id: 'reg-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
