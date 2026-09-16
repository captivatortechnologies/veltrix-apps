// ============================================================================
// rollback for Entra service principals, against a fake Microsoft Graph.
//
// Deleting a service principal uninstalls an enterprise application from the
// tenant — every assignment, SSO configuration and consent grant attached to it
// goes too. So the provenance rule is the load-bearing one: an SP this deploy
// CREATED may be deleted, an SP that already existed is only ever PATCHed back
// to the live values captured at deploy time. The same rule governs ownership:
// only an owner reference this deploy granted is revoked, and the revoke ends
// in `/$ref` so it de-links the owner rather than deleting the principal.
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

const APP_ID = '77777777-7777-4777-8777-777777777777'

/** The managed-field snapshot deploy records for an SP it updated. */
const PRIOR = {
  accountEnabled: false,
  appRoleAssignmentRequired: true,
  preferredSingleSignOnMode: 'password',
  homepage: 'https://old.contoso.com',
  notificationEmailAddresses: ['old-ops@contoso.com'],
  tags: ['WindowsAzureActiveDirectoryIntegratedApp'],
}

function updated(over: Record<string, unknown> = {}) {
  return { appId: APP_ID, existed: true, id: 'sp-1', prior: PRIOR, ...over }
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

test('rollback restores the live prior fields captured at deploy, not the canvas values', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [updated()] }))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith('/servicePrincipals/sp-1'))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('a pre-existing enterprise app is restored, never uninstalled', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({}), NO_CONTENT])
  try {
    await rollback(rollbackContext({ entries: [updated({ owners: [{ id: 'u-new', existed: false }] })] }))

    const writes = writeCalls(calls).map((c) => `${c.method} ${c.url.replace(/^.*\/v1\.0/, '')}`)
    assert.deepEqual(writes, [
      'PATCH /servicePrincipals/sp-1',
      'DELETE /servicePrincipals/sp-1/owners/u-new/$ref',
    ])
    assert.equal(writes.includes('DELETE /servicePrincipals/sp-1'), false)
  } finally {
    restore()
  }
})

test('rollback deletes an SP the deploy created, without chasing its owners', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [{ appId: APP_ID, existed: false, id: 'sp-new', owners: [{ id: 'u-1', existed: false }] }],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'deleting the SP takes its owner references with it')
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith('/servicePrincipals/sp-new'))
    assert.equal(writes[0].url.includes('$ref'), false)
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('rollback revokes only the owner references this deploy added', async () => {
  const { calls, restore } = routeFetch([
    { url: /\$ref$/, method: 'DELETE', respond: NO_CONTENT },
    { url: /\/servicePrincipals\/sp-1$/, method: 'PATCH', respond: ok({}) },
  ])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          updated({
            owners: [
              { id: 'u-added', existed: false },
              { id: 'u-preexisting', existed: true },
            ],
          }),
        ],
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      revokes.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      ['/servicePrincipals/sp-1/owners/u-added/$ref'],
      'an ownership that pre-dated this deploy must survive the rollback',
    )
    assert.ok(revokes[0].url.endsWith('/$ref'))
    assert.match(String(result.message), /1 owner\(s\) revoked/)
  } finally {
    restore()
  }
})

test('an SP already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ appId: APP_ID, existed: false, id: 'sp-new' }] }))

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

test('an updated SP with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ appId: APP_ID, existed: true, id: 'sp-1' }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no recorded id is skipped rather than addressed blindly', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ appId: APP_ID, existed: false }] }))

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
