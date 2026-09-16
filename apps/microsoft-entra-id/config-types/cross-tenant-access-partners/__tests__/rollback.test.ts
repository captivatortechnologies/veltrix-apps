// ============================================================================
// rollback for cross-tenant access PARTNER configurations, against a fake Graph.
//
// Provenance decides everything here: a partner configuration THIS app created
// is deleted outright, one that already existed is patched back to the live
// values deploy read before it overwrote them. Get that backwards and a rollback
// either deletes a trust relationship the customer set up by hand, or leaves an
// outside tenant with the access this deploy granted it.
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

const BASE = '/policies/crossTenantAccessPolicy/partners'
const PARTNER = 'c4f8a5d2-1b3e-4a7c-9d6f-8e2b5c1a0f77'
const OTHER_PARTNER = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

/** What deploy read from the tenant before overwriting it. */
const PRIOR = {
  b2bCollaborationInbound: {
    usersAndGroups: { accessType: 'allowed', targets: [{ target: 'AllUsers', targetType: 'user' }] },
  },
  inboundTrust: {
    isMfaAccepted: true,
    isCompliantDeviceAccepted: true,
    isHybridAzureADJoinedDeviceAccepted: false,
  },
}

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: PARTNER, existed: false, id: PARTNER }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the live prior configuration captured at deploy', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: PARTNER, existed: true, id: PARTNER, prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/${PARTNER}`))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR, 'the restore body is the recorded prior, byte for byte')
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a partner configuration the deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: PARTNER, existed: false, id: PARTNER }] }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith(`${BASE}/${PARTNER}`))
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('a pre-existing partner is restored while an app-created one is deleted, in the same run', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: PARTNER, existed: true, id: PARTNER, prior: PRIOR },
          { name: OTHER_PARTNER, existed: false, id: OTHER_PARTNER },
        ],
      }),
    )

    assert.deepEqual(
      writeCalls(calls).map((c) => `${c.method} ${c.url.replace(/^.*\/v1\.0/, '')}`),
      [`PATCH ${BASE}/${PARTNER}`, `DELETE ${BASE}/${OTHER_PARTNER}`],
    )
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('a partner already gone (404) is treated as already undone', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: PARTNER, existed: false, id: PARTNER }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('a 404 while restoring is likewise not an error', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: PARTNER, existed: true, id: PARTNER, prior: PRIOR }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('an updated partner with no recorded prior is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: PARTNER, existed: true, id: PARTNER }] }),
    )

    assert.equal(writeCalls(calls).length, 0, 'an unknown prior must not become an invented one')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped rather than addressed by name', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: PARTNER, existed: false, prior: PRIOR }] }))

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
      rollbackContext({ entries: [{ name: PARTNER, existed: true, id: PARTNER, prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /restore/)
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
