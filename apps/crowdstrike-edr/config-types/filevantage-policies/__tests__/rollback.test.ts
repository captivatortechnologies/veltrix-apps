// rollback for filevantage-policies.
//
// The shared contract covers the refusals every config type has: no credential,
// nothing recorded, an empty recording, a recording of the wrong shape. What is
// specific here is that assignments live on side endpoints, so the restore is
// not one PATCH: it reverses exactly the deltas deploy recorded — detach what
// deploy attached, re-attach what deploy detached — and then puts the rule-group
// precedence back to the LIVE prior order.

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

const HOST_GROUPS = /\/filevantage\/entities\/policies-host-groups\/v1/
const RULE_GROUPS = /\/filevantage\/entities\/policies-rule-groups\/v1/
const POLICIES = /\/filevantage\/entities\/policies\/v1/

const CREATED_ENTRY = {
  name: 'veltrix-fim-windows',
  platform: 'Windows',
  existed: false,
  id: 'fvp-new-1',
}

const UPDATED_ENTRY = {
  name: 'veltrix-fim-windows',
  platform: 'Windows',
  existed: true,
  id: 'fvp-live-1',
  prior: {
    name: 'veltrix-fim-windows',
    description: 'legacy description nobody updated',
    enabled: false,
    hostGroupsAdded: ['hg-prod', 'hg-dmz'],
    hostGroupsRemoved: ['hg-legacy'],
    ruleGroupsAdded: ['rg-system'],
    ruleGroupsRemoved: ['rg-old'],
    ruleGroupsPriorOrder: ['rg-old', 'rg-registry'],
  },
}

/** Actions applied to one side endpoint, in the order the handler issued them. */
function actions(calls: Array<{ url: string }>, path: RegExp): string[] {
  return calls
    .filter((c) => path.test(c.url))
    .map((c) => {
      const url = new URL(c.url)
      return `${url.searchParams.get('action')}:${url.searchParams.getAll('ids').join('>')}`
    })
}

registerRollbackGuardContract({
  label: 'filevantage-policies',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('filevantage-policies rollback: disables then deletes a policy this deploy created', async () => {
  // FileVantage will not remove an enabled policy cleanly, so the disable comes
  // first — and a failure there must not stop the delete.
  const { calls, restore } = routeFetch([
    { url: POLICIES, method: 'PATCH', respond: ok() },
    { url: POLICIES, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const patch = callsOfMethod(calls, 'PATCH')[0]
    assert.ok(patch, 'the policy must be disabled before it is deleted')
    assert.equal(bodyOf(patch)?.id, 'fvp-new-1')
    assert.equal(bodyOf(patch)?.enabled, false)

    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=fvp-new-1/)
    assert.ok(calls.indexOf(patch) < calls.indexOf(deletes[0]), 'disable precedes delete')
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: still deletes when the disable is rejected', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICIES, method: 'PATCH', respond: forbidden('access denied, authorization failed') },
    { url: POLICIES, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 1, 'the best-effort disable must not block the delete')
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: treats a 404 on the delete as already gone', async () => {
  // "Gone" is a known answer, unlike a 5xx — a concurrent delete must be a no-op.
  const { restore } = routeFetch([
    { url: POLICIES, method: 'PATCH', respond: ok() },
    { url: POLICIES, method: 'DELETE', respond: notFound() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: writes nothing for a created entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'veltrix-fim-windows', platform: 'Windows', existed: false }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: reverses exactly the assignment deltas deploy recorded', async () => {
  const { calls, restore } = routeFetch([
    { url: HOST_GROUPS, respond: ok() },
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'PATCH', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'a policy that existed before the deploy must never be deleted',
    )

    assert.deepEqual(actions(calls, HOST_GROUPS), [
      'unassign:hg-prod',
      'unassign:hg-dmz',
      'assign:hg-legacy',
    ])
    assert.deepEqual(actions(calls, RULE_GROUPS), [
      'unassign:rg-system',
      'assign:rg-old',
      'precedence:rg-old>rg-registry',
    ])
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: restores the recorded prior name, description and enablement', async () => {
  const { calls, restore } = routeFetch([
    { url: HOST_GROUPS, respond: ok() },
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH').find((c) => POLICIES.test(c.url)))
    assert.equal(body?.id, 'fvp-live-1')
    assert.equal(body?.name, 'veltrix-fim-windows')
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(body?.enabled, false, 'the policy was disabled before the deploy enabled it')
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: clears a description the deploy added rather than leaving it behind', async () => {
  const entry = {
    ...UPDATED_ENTRY,
    prior: {
      ...UPDATED_ENTRY.prior,
      description: '',
      hostGroupsAdded: [],
      hostGroupsRemoved: [],
      ruleGroupsAdded: [],
      ruleGroupsRemoved: [],
      ruleGroupsPriorOrder: [],
    },
  }
  const { calls, restore } = routeFetch([{ url: POLICIES, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.equal(bodyOf(callsOfMethod(calls, 'PATCH')[0])?.description, '')
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: makes no precedence call when the prior order had fewer than two groups', async () => {
  const entry = {
    ...UPDATED_ENTRY,
    prior: {
      ...UPDATED_ENTRY.prior,
      hostGroupsAdded: [],
      hostGroupsRemoved: [],
      ruleGroupsAdded: [],
      ruleGroupsRemoved: [],
      ruleGroupsPriorOrder: ['rg-registry'],
    },
  }
  const { calls, restore } = routeFetch([
    { url: RULE_GROUPS, respond: ok() },
    { url: POLICIES, method: 'PATCH', respond: ok() },
  ])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    assert.deepEqual(actions(calls, RULE_GROUPS), [], 'one rule group has no order to restore')
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy converged a live policy but recorded no prior body. Restoring an
  // invented default would detach every group and disable a live FIM policy.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'veltrix-fim-windows', platform: 'Windows', existed: true, id: 'fvp-live-1' },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          { name: 'veltrix-fim-windows', platform: 'Windows', existed: true, prior: UPDATED_ENTRY.prior },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: POLICIES, method: 'PATCH', respond: ok() },
    { url: POLICIES, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
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

test('filevantage-policies rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: POLICIES, method: 'PATCH', respond: partialFailure('policy is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored policy')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('filevantage-policies rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    { url: POLICIES, method: 'PATCH', respond: ok() },
    { url: POLICIES, method: 'DELETE', respond: [ok(), forbidden('access denied, authorization failed')] },
  ])
  try {
    const second = { ...CREATED_ENTRY, name: 'veltrix-fim-linux', platform: 'Linux', id: 'fvp-new-2' }
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 4, 'both entries were attempted, disable then delete each')
  } finally {
    restore()
  }
})
