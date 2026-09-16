// ============================================================================
// rollback for home realm discovery policies, against a fake Microsoft Graph.
//
// Two provenance rules decide what this handler is allowed to touch:
//   * a policy THIS deploy created is deleted (its assignments go with it); one
//     that already existed is patched back to the live values deploy read;
//   * an assignment THIS deploy made is detached, one that was already on the
//     service principal is left in place — detaching that would change where a
//     real application's users authenticate.
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

const BASE = '/policies/homeRealmDiscoveryPolicies'
const SP_ID = '7c1f0a3e-5d92-4b18-9c6a-2f3e8b7d4a15'
const OTHER_SP_ID = '3d8b2f61-4e07-4a5c-8b93-1a6d5c0e7f24'

const PRIOR = {
  displayName: 'Accelerate Contoso',
  definition: [JSON.stringify({ HomeRealmDiscoveryPolicy: { AccelerateToFederatedDomain: false } })],
  isOrganizationDefault: false,
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Accelerate Contoso', existed: false, id: 'hrd-1' }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior policy captured at deploy', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Accelerate Contoso', existed: true, id: 'hrd-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/hrd-1`))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR, 'the restore body is the recorded prior, byte for byte')
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored, 0 assignment/)
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
            name: 'Accelerate Contoso',
            existed: false,
            id: 'hrd-new',
            appliesTo: [{ id: SP_ID, kind: 'servicePrincipal', existed: false }],
          },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'deleting the policy takes its assignments with it')
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith(`${BASE}/hrd-new`))
    assert.equal(writes[0].url.includes('$ref'), false)
    assert.match(String(result.message), /1 deleted, 0 restored, 0 assignment/)
  } finally {
    restore()
  }
})

test('rollback detaches only the assignments this deploy made', async () => {
  const { calls, restore } = routeFetch([
    { url: /\/servicePrincipals\//, method: 'DELETE', respond: NO_CONTENT },
    { url: /\/policies\//, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: 'Accelerate Contoso',
            existed: true,
            id: 'hrd-1',
            prior: PRIOR,
            appliesTo: [
              { id: SP_ID, kind: 'servicePrincipal', existed: false },
              { id: OTHER_SP_ID, kind: 'servicePrincipal', existed: true },
            ],
          },
        ],
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      revokes.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      [`/servicePrincipals/${SP_ID}/homeRealmDiscoveryPolicies/hrd-1/$ref`],
      'an assignment that pre-dated this deploy must survive the rollback',
    )
    // The trailing /$ref keeps this a detach rather than a delete of the policy.
    assert.ok(revokes[0].url.endsWith('/$ref'))
    assert.match(String(result.message), /1 restored, 1 assignment\(s\) removed/)
  } finally {
    restore()
  }
})

test('a policy already gone (404) is treated as already undone', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Accelerate Contoso', existed: false, id: 'hrd-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('an assignment already detached (404) is likewise not an error', async () => {
  const { restore } = routeFetch([
    { url: /\/servicePrincipals\//, method: 'DELETE', respond: notFound() },
    { url: /\/policies\//, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: 'Accelerate Contoso',
            existed: true,
            id: 'hrd-1',
            prior: PRIOR,
            appliesTo: [{ id: SP_ID, kind: 'servicePrincipal', existed: false }],
          },
        ],
      }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 assignment\(s\) removed/)
  } finally {
    restore()
  }
})

test('an updated policy with no recorded prior is not patched with a guess', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Accelerate Contoso', existed: true, id: 'hrd-1' }] }),
    )

    assert.equal(writeCalls(calls).filter((c) => c.method === 'PATCH').length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped rather than addressed by name', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Accelerate Contoso', existed: false, prior: PRIOR }] }),
    )

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Accelerate Contoso', existed: true, id: 'hrd-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /restore Accelerate Contoso/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
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
