// rollback for idp-policy-rules.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here follows from there being no PATCH: rollback also works
// replace-in-place, so it must delete only what the deploy created, recreate the
// prior rule only when the deploy actually deleted it, and — for an entry the
// deploy left untouched — do nothing at all.

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

const ENTITY = /\/identity-protection\/entities\/policy-rules\/v1/

/** The prior rule's recreatable body — the LIVE values, not the canvas's. */
const PRIOR_RULE = {
  name: 'Block legacy authentication',
  enabled: false,
  simulationMode: true,
  action: 'ALLOW',
  activity: { accessType: ['RDP'] },
}

const CREATED_ENTRY = {
  name: 'Block legacy authentication',
  existed: false,
  replaced: false,
  createdId: 'rule-new-1',
}

const REPLACED_ENTRY = {
  name: 'Block legacy authentication',
  existed: true,
  replaced: true,
  deleted: true,
  priorId: 'rule-live-1',
  priorRule: PRIOR_RULE,
  createdId: 'rule-new-2',
}

/** Deploy found the rule already correct and changed nothing. */
const NOOP_ENTRY = { name: 'Block legacy authentication', existed: true, replaced: false }

registerRollbackGuardContract({ label: 'idp-policy-rules', handler: rollback, entry: CREATED_ENTRY })

test('idp-policy-rules rollback: deletes a rule this deploy created', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=rule-new-1/)
    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'there was no prior rule to bring back')
  } finally {
    restore()
  }
})

test('idp-policy-rules rollback: leaves a rule the deploy never changed completely alone', async () => {
  // Deploy recorded a no-op because the live rule already matched. Touching it
  // now would delete a working authentication policy to "undo" nothing.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    const result = await rollback(rollbackContext({ previousState: [NOOP_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('idp-policy-rules rollback: deletes the replacement, then recreates the recorded prior rule', async () => {
  const { calls, restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: ok() },
    { url: ENTITY, method: 'POST', respond: ok({ meta: {}, resources: [{ id: 'rule-restored-1' }] }) },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [REPLACED_ENTRY] }))

    assert.equal(result.success, true)

    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=rule-new-2/, 'only the rule this deploy created may be deleted')

    const posts = callsOfMethod(calls, 'POST')
    assert.equal(posts.length, 1, `expected exactly one recreate, got ${describeCalls(posts)}`)
    const body = bodyOf(posts[0])
    assert.equal(body?.enabled, false, 'the LIVE prior enablement, not the desired one')
    assert.equal(body?.simulationMode, true)
    assert.equal(body?.action, 'ALLOW')
    assert.deepEqual(body?.activity, { accessType: ['RDP'] })

    const sequence = vendorCalls(calls).map((c) => c.method)
    assert.ok(
      sequence.indexOf('DELETE') < sequence.indexOf('POST'),
      `the replacement goes before the prior rule comes back, got ${sequence.join(' → ')}`,
    )
  } finally {
    restore()
  }
})

test('idp-policy-rules rollback: does not recreate a prior rule the deploy never actually deleted', async () => {
  // The delete failed mid-replace, so the original is still live. Recreating it
  // would leave the tenant with two rules of the same name.
  const entry = { ...REPLACED_ENTRY, deleted: undefined }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(
      callsOfMethod(calls, 'POST').length,
      0,
      `rollback duplicated a live rule: ${describeCalls(callsOfMethod(calls, 'POST'))}`,
    )
  } finally {
    restore()
  }
})

test('idp-policy-rules rollback: writes no invented rule when the prior body was never captured', async () => {
  // Restoring a made-up authentication policy is strictly worse than leaving the
  // tenant as it is and telling the operator.
  const entry = { name: 'Block legacy authentication', existed: true, replaced: true, deleted: true, createdId: 'rule-new-2' }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(callsOfMethod(calls, 'POST').length, 0, 'no recorded prior means nothing to recreate')
  } finally {
    restore()
  }
})

test('idp-policy-rules rollback: writes nothing for a created entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'Block legacy authentication', existed: false, replaced: false }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('idp-policy-rules rollback: treats a 404 on the delete as the rule already being gone', async () => {
  const { restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true, '"gone" is a known answer, not a failure')
  } finally {
    restore()
  }
})

test('idp-policy-rules rollback: undoes in reverse deploy order', async () => {
  // Deploy created in precedence order, so rollback unwinds last-in-first-out.
  const second = { ...CREATED_ENTRY, name: 'Allow break glass', createdId: 'rule-new-2' }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'DELETE', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [CREATED_ENTRY, second] }))

    const order = callsOfMethod(calls, 'DELETE').map((c) => (c.url.includes('rule-new-2') ? 2 : 1))
    assert.deepEqual(order, [2, 1])
  } finally {
    restore()
  }
})

test('idp-policy-rules rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
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

test('idp-policy-rules rollback: treats HTTP 200 with a populated errors[] on the recreate as a failure', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'DELETE', respond: ok() },
    { url: ENTITY, method: 'POST', respond: partialFailure('policy rule limit reached') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [REPLACED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored rule')
    assert.match(String(result.message), /recreate prior rule/)
    assert.match(String(result.message), /policy rule limit reached/)
  } finally {
    restore()
  }
})

test('idp-policy-rules rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'DELETE',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...CREATED_ENTRY, name: 'Allow break glass', createdId: 'rule-new-2' }
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.ok(vendorCalls(calls).length >= 2, 'both entries were attempted, in reverse order')
  } finally {
    restore()
  }
})
