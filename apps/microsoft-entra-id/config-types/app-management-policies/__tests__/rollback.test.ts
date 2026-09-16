// ============================================================================
// rollback for Entra app management policies, against a fake Microsoft Graph.
//
// Rolling one of these back has two halves and both carry a provenance rule. A
// policy this deploy CREATED is deleted; one it merely updated is PATCHed back
// to the live values captured at deploy time. Separately, an assignment this
// deploy made is removed, while an assignment that was already on the target is
// left where it is — and the removal addresses
// `{target}/appManagementPolicies/{policyId}/$ref`, so it de-links the policy
// rather than touching the application or service principal itself.
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
  notFound,
  ok,
  recordFetch,
  rollbackContext,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

/** The snapshot deploy records before updating a pre-existing policy. */
const PRIOR = {
  displayName: 'No app passwords',
  description: 'Block password credentials',
  isEnabled: true,
  restrictions: { passwordCredentials: [{ restrictionType: 'passwordAddition', state: 'enabled' }] },
}

function updated(over: Record<string, unknown> = {}) {
  return { name: 'No app passwords', existed: true, id: 'p-1', prior: PRIOR, ...over }
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }, { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior state captured at deploy, not the canvas values', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/policies/appManagementPolicies/p-1'))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a policy the deploy created, without chasing its assignments', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: 'New policy',
            existed: false,
            id: 'p-new',
            appliesTo: [{ id: 'app-1', kind: 'application', existed: false }],
          },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'deleting the policy takes its assignments with it')
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/policies/appManagementPolicies/p-new'))
    assert.equal(writes[0].url.includes('$ref'), false)
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('rollback removes only the assignments this deploy made, on the right target base', async () => {
  const { calls, restore } = routeFetch([
    { url: /\$ref$/, method: 'DELETE', respond: NO_CONTENT },
    { url: /\/policies\/appManagementPolicies\/p-1$/, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          updated({
            appliesTo: [
              { id: 'app-1', kind: 'application', existed: false },
              { id: 'sp-1', kind: 'servicePrincipal', existed: false },
              { id: 'app-preexisting', kind: 'application', existed: true },
            ],
          }),
        ],
      }),
    )

    const unassigns = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      unassigns.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      [
        '/applications/app-1/appManagementPolicies/p-1/$ref',
        '/servicePrincipals/sp-1/appManagementPolicies/p-1/$ref',
      ],
      'an assignment that pre-dated this deploy must survive, and each kind has its own base',
    )
    for (const call of unassigns) assert.ok(call.url.endsWith('/$ref'))
    assert.match(String(result.message), /2 assignment\(s\) removed/)
  } finally {
    restore()
  }
})

test('a policy already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'New policy', existed: false, id: 'p-new' }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('a 404 on the restore PATCH is likewise treated as already-undone', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('an updated policy with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'No app passwords', existed: true, id: 'p-1' }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no recorded id is skipped rather than addressed blindly', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'No app passwords', existed: false }] }))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback does nothing when the deploy recorded no entries', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})
