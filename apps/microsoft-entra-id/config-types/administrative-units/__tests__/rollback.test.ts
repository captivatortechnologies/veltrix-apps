// ============================================================================
// rollback for Entra administrative units, against a fake Microsoft Graph.
//
// Two provenance rules meet here, and both are load-bearing. A unit this deploy
// CREATED is deleted outright; a unit that already existed is PATCHed back and
// keeps its membership except for the members this deploy itself added. Get
// either backwards and undoing a bad deploy either destroys a delegation
// boundary the tenant built or evicts people from one they always belonged to.
//
// The trailing "/$ref" on every membership DELETE is the other thing worth
// asserting: without it Graph deletes the member OBJECT — the user — instead of
// the membership.
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
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const BASE = '/directory/administrativeUnits'
const PRIOR = { displayName: 'West Region', description: 'Old description', visibility: 'HiddenMembership' }

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'West Region', existed: true, id: 'au-1', prior: PRIOR }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback restores the LIVE prior fields captured at deploy, verbatim', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'West Region', existed: true, id: 'au-1', prior: PRIOR }] }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1)
    assert.equal(graphCalls[0].method, 'PATCH')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/au-1`))
    assert.deepEqual(bodyOf(graphCalls[0]), PRIOR)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
  } finally {
    restore()
  }
})

test('rollback deletes a unit the deploy created, without chasing its members', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [{ name: 'New Region', existed: false, id: 'au-new', members: [{ id: 'u-1', existed: false }] }],
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'deleting the unit takes its memberships with it')
    assert.equal(writes[0].method, 'DELETE')
    assert.ok(writes[0].url.endsWith(`${BASE}/au-new`))
    assert.ok(!writes[0].url.includes('$ref'))
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('rollback evicts only the members this deploy added, and only by reference', async () => {
  const { calls, restore } = routeFetch([{ url: /administrativeUnits/, respond: NO_CONTENT }])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: 'West Region',
            existed: true,
            id: 'au-1',
            prior: PRIOR,
            members: [
              { id: 'u-ours', existed: false },
              { id: 'u-theirs', existed: true },
            ],
          },
        ],
      }),
    )

    const evictions = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.deepEqual(
      evictions.map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      [`${BASE}/au-1/members/u-ours/$ref`],
      'a member that pre-dated this deploy must survive the rollback',
    )
    // The trailing /$ref is what keeps this a de-link instead of deleting the user.
    assert.ok(evictions[0].url.endsWith('/$ref'))
    assert.match(String(result.message), /1 member\(s\) revoked/)
  } finally {
    restore()
  }
})

test('a unit already gone (404) is not an error — rollback is idempotent', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'New Region', existed: false, id: 'au-new' }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('a membership already gone (404) is likewise not an error', async () => {
  const { restore } = routeFetch([
    { url: /\/members\/[^/]+\/\$ref$/, method: 'DELETE', respond: notFound() },
    { url: /administrativeUnits/, respond: NO_CONTENT },
  ])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'West Region', existed: true, id: 'au-1', prior: PRIOR, members: [{ id: 'u-ours', existed: false }] },
        ],
      }),
    )

    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an updated unit with no recorded prior keeps its fields, but its added members are still evicted', async () => {
  const { calls, restore } = routeFetch([{ url: /administrativeUnits/, respond: NO_CONTENT }])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [{ name: 'West Region', existed: true, id: 'au-1', members: [{ id: 'u-ours', existed: false }] }],
      }),
    )

    assert.deepEqual(
      writeCalls(calls).map((c) => c.method),
      ['DELETE'],
      'with no snapshot there is nothing to PATCH back — inventing one would rewrite the unit blind',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped rather than aimed at the wrong unit', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'West Region', existed: false }] }))

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

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: 'West Region', existed: true, id: 'au-1', prior: PRIOR }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback had errors/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
