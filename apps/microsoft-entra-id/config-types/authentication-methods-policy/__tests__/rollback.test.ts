// ============================================================================
// rollback for the Entra authentication methods policy, against a fake Graph.
//
// Method configurations are tenant singletons, so rollback has exactly one move:
// PATCH each recorded prior `state` back. Nothing is ever created or deleted
// here, and a rollback that re-sent the canvas values instead of the recorded
// priors would leave the tenant in whichever state the bad deploy put it.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  graphError,
  leaksSecret,
  recordFetch,
  rollbackContext,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'
import { METHOD_ODATA_TYPES } from '../validate'

const BASE = '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations'

/** What deploy recorded for SMS: the tenant HAD it enabled. */
const SMS_PRIOR = { '@odata.type': METHOD_ODATA_TYPES.sms, state: 'enabled' }

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ method: 'sms', existed: true, prior: SMS_PRIOR }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback refuses when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ method: 'sms', existed: true, prior: SMS_PRIOR }] }, { settings: {} }),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback PATCHes back exactly the prior body deploy captured', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ entries: [{ method: 'sms', existed: true, prior: SMS_PRIOR }] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/sms`), `PATCH target was ${graphCalls[0].url}`)
    assert.deepEqual(bodyOf(graphCalls[0]), SMS_PRIOR)

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('every recorded method is restored at its own endpoint, in order', async () => {
  const fido2Prior = { '@odata.type': METHOD_ODATA_TYPES.fido2, state: 'disabled' }
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { method: 'sms', existed: true, prior: SMS_PRIOR },
          { method: 'fido2', existed: true, prior: fido2Prior },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.ok(writes[0].url.endsWith(`${BASE}/sms`))
    assert.deepEqual(bodyOf(writes[0]), SMS_PRIOR)
    assert.ok(writes[1].url.endsWith(`${BASE}/fido2`))
    assert.deepEqual(bodyOf(writes[1]), fido2Prior)
    assert.match(String(result.message), /2 restored/)
  } finally {
    restore()
  }
})

test('an entry with no recorded prior is left alone, never guessed at', async () => {
  // Guessing here would mean picking a state for a method nobody recorded — the
  // wrong guess either locks a tenant out of MFA or hands it a weaker factor.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ method: 'sms', existed: true }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 restored/)
  } finally {
    restore()
  }
})

test('a method configuration is never deleted — rollback only ever PATCHes', async () => {
  // Graph owns these singletons; there is no DELETE to make, and an entry that
  // claims otherwise must not produce one.
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(rollbackContext({ entries: [{ method: 'sms', existed: false, prior: SMS_PRIOR }] }))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH')
    assert.equal(
      writes.filter((c) => c.method === 'DELETE').length,
      0,
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback does nothing at all when the deploy recorded no rollbackData', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(rollbackContext({ entries: [{ method: 'sms', existed: true, prior: SMS_PRIOR }] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback had errors/)
    assert.match(String(result.message), /restore sms: .*Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
