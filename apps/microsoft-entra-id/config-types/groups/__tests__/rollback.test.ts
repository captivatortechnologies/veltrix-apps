// ============================================================================
// rollback for Entra security groups, against a fake Microsoft Graph.
//
// The provenance rule is the whole point of this handler: a membership or
// ownership the deploy ADDED is revoked, one that was already there is left
// alone. Get that backwards and a rollback strips people out of a group they
// belonged to before Veltrix ever saw it.
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

const PRIOR = { displayName: 'Engineering', description: 'Old description', mailNickname: 'eng-old' }

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Engineering', existed: false, id: 'g-1' }] }, { credential: null }),
    )

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
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Engineering', existed: true, id: 'g-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.includes('/groups/g-1'))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a group the deploy created, without chasing its references', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: 'New Group',
            existed: false,
            id: 'g-new',
            members: [{ id: 'u-1', existed: false }],
          },
        ],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'deleting the group takes its references with it')
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.includes('/groups/g-new'))
    assert.ok(!writes[0].url.includes('$ref'))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback revokes only the references this deploy added', async () => {
  const { calls, restore } = routeFetch([{ url: /\$ref$/, method: 'DELETE', respond: NO_CONTENT }])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: 'Engineering',
            existed: true,
            id: 'g-1',
            prior: PRIOR,
            owners: [
              { id: 'u-owner-new', existed: false },
              { id: 'u-owner-old', existed: true },
            ],
            members: [
              { id: 'u-member-new', existed: false },
              { id: 'u-member-old', existed: true },
            ],
          },
        ],
      }),
    )

    const revokes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      revokes.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      ['/groups/g-1/owners/u-owner-new/$ref', '/groups/g-1/members/u-member-new/$ref'],
      'a reference that pre-dated this deploy must survive the rollback',
    )
    // The trailing /$ref is what keeps this a de-link instead of deleting the user.
    for (const call of revokes) assert.ok(call.url.endsWith('/$ref'))
    assert.match(String(result.message), /2 owner\/member reference\(s\) revoked/)
  } finally {
    restore()
  }
})

test('a group already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'New Group', existed: false, id: 'g-new' }] }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Engineering', existed: true, id: 'g-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('an updated group with no recorded prior state is left alone, never guessed at', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'Engineering', existed: true, id: 'g-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0)
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
