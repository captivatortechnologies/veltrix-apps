// ============================================================================
// rollback for external (social) identity providers, against a fake Graph.
//
// Undoing a provider means removing a way into the tenant, so provenance is the
// whole question: a provider THIS deploy created is deleted, one that already
// existed is patched back to the display name and client id deploy read from it.
// The client secret is write-only — Graph never returns it, so it is never in
// the recorded prior and rollback cannot (and must not pretend to) restore it.
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
  recordFetch,
  rollbackContext,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const BASE = '/identity/identityProviders'

const PRIOR = {
  '@odata.type': '#microsoft.graph.socialIdentityProvider',
  displayName: 'Google',
  clientId: 'old-client-id.apps.googleusercontent.com',
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Google', existed: false, id: 'Google-OAUTH' }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior fields captured at deploy', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Google', existed: true, id: 'Google-OAUTH', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/Google-OAUTH`))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('the restore body carries no client secret, because none was ever readable', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    await rollback(
      rollbackContext({ entries: [{ name: 'Google', existed: true, id: 'Google-OAUTH', prior: PRIOR }] }),
    )

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('clientSecret' in body, false, 'inventing a secret here would break the provider outright')
  } finally {
    restore()
  }
})

test('rollback deletes a provider the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Google', existed: false, id: 'Google-OAUTH' }] }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith(`${BASE}/Google-OAUTH`))
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('a pre-existing provider is restored while an app-created one is deleted', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'Google', existed: true, id: 'Google-OAUTH', prior: PRIOR },
          { name: 'GitHub', existed: false, id: 'GitHub-OAUTH' },
        ],
      }),
    )

    assert.deepEqual(
      writeCalls(calls).map((c) => `${c.method} ${c.url.replace(/^.*\/v1\.0/, '')}`),
      [`PATCH ${BASE}/Google-OAUTH`, `DELETE ${BASE}/GitHub-OAUTH`],
    )
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('a provider already gone (404) is treated as already undone', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Google', existed: false, id: 'Google-OAUTH' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('an updated provider with no recorded prior is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Google', existed: true, id: 'Google-OAUTH' }] }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped rather than addressed by name', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'Google', existed: false }] }))

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
      rollbackContext({ entries: [{ name: 'Google', existed: false, id: 'Google-OAUTH' }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /delete Google/)
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
