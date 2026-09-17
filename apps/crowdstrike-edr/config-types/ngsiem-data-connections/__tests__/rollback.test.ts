// rollback for ngsiem-data-connections.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that the upstream cloud credential was never read back, so a
// restore can only put the NON-SECRET fields back — and must say so rather than
// writing a blank credential over a working one.
//
// The upstream-secret leak check below is LOCAL to this file: the shared
// `leaksSecret` only knows the Falcon token and API client secret.

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

const STATUS = /\/ngsiem\/entities\/connections\/status\/v1/
const ENTITY = /\/ngsiem\/entities\/connections\/v1/

const UPSTREAM_SECRET = 'aws-upstream-access-key-MUST-NOT-LEAK'

function leaksUpstreamSecret(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(UPSTREAM_SECRET)
}

const CREATED_ENTRY = { name: 'acme-cloudtrail', existed: false, id: 'conn-new-1' }

const UPDATED_ENTRY = {
  name: 'acme-cloudtrail',
  existed: true,
  id: 'conn-live-1',
  prior: {
    name: 'acme-cloudtrail',
    connector_type: 'aws-s3',
    parser: 'legacy-parser',
    repository: 'legacy-repository',
    endpoint: 's3://old-bucket',
    status: 'disabled',
    description: 'legacy description nobody updated',
  },
}

registerRollbackGuardContract({
  label: 'ngsiem-data-connections',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('ngsiem-data-connections rollback: deletes a connection this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=conn-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created connection is deleted, not patched')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections rollback: treats an already-deleted connection as done rather than failing', async () => {
  const { restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true, '404 on a delete is the desired end state, not an error')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections rollback: writes nothing for a created entry whose id was never captured', async () => {
  // Deploy recorded the connection but the create returned no id. There is no
  // safe target to delete, so nothing is written — see the accompanying report:
  // the orphaned connection cannot be removed by rollback at all.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ name: 'acme-cloudtrail', existed: false }] }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections rollback: restores the recorded non-secret values of a connection it overwrote', async () => {
  const { calls, restore } = routeFetch([
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH').filter((c) => !STATUS.test(c.url))
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)
    assert.match(patches[0].url, /ids=conn-live-1/)

    const body = bodyOf(patches[0])
    assert.ok(body, 'the restore carried no JSON body')
    assert.equal(body.name, 'acme-cloudtrail')
    assert.equal(body.parser, 'legacy-parser')
    assert.equal(body.description, 'legacy description nobody updated')

    // The whole `config` is replaced, so both non-secret params go back
    // together — restoring one alone would drop the other.
    const config = body.config as Record<string, unknown>
    assert.equal(config.repository, 'legacy-repository')
    assert.equal(config.endpoint, 's3://old-bucket')
    assert.equal(
      Object.prototype.hasOwnProperty.call(config, 'credential'),
      false,
      'rollback must not write a credential it never read back',
    )
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated connection must never be deleted')
  } finally {
    restore()
  }
})

test('ngsiem-data-connections rollback: restores the prior enable/disable state', async () => {
  const { calls, restore } = routeFetch([
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const statusCalls = calls.filter((c) => STATUS.test(c.url))
    assert.equal(statusCalls.length, 1, `expected one status restore, got ${describeCalls(statusCalls)}`)
    assert.match(statusCalls[0].url, /ids=conn-live-1/)
    assert.equal(
      bodyOf(statusCalls[0])?.status,
      'disabled',
      'a forwarder the deploy switched on must be switched off again',
    )
  } finally {
    restore()
  }
})

test('ngsiem-data-connections rollback: says the credential is not restored', async () => {
  // Operators have to know the connection is running on whatever credential the
  // deploy set, not the one it had before.
  const { restore } = routeFetch([
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.match(String(result.message), /Credentials are not restored by rollback/)
    assert.equal(leaksUpstreamSecret(result), false)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live connection but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving it alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ name: 'acme-cloudtrail', existed: true, id: 'conn-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'acme-cloudtrail', existed: true, prior: { parser: 'legacy-parser' } }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
    assert.equal(leaksUpstreamSecret(result), false)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: STATUS, method: 'PATCH', respond: ok() },
    { url: ENTITY, method: 'PATCH', respond: partialFailure('connection is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored connection')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('ngsiem-data-connections rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: STATUS, method: 'PATCH', respond: ok() },
    {
      url: ENTITY,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'acme-vpc-flow', id: 'conn-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.ok(vendorCalls(calls).length >= 3, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})
