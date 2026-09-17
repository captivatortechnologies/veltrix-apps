// deploy for reference-map-of-sets.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the classic name-keyed reference-data flow for a collection whose every KEY
// holds a SET of values: GET the collection by name, create it on a 404,
// reconcile its (key, value) pairs to exactly the declared set, and record the
// LIVE prior pairs so rollback can put them back. The element type is
// immutable, so a live type mismatch must refuse rather than overwrite.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  canvas,
  deployContext,
  forbidden,
  item,
  leaksToken,
  notFound,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  routeFetch,
  serverError,
  transportFailure,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const ADMIN_USERS = item('Admin Users', {
  name: 'Admin Users',
  elementType: 'ALN',
  entries: 'finance = alice, bob\nops = carol',
})

registerDeployGuardContract({ label: 'reference-map-of-sets', handler: deploy, sampleItems: [ADMIN_USERS] })

/** A live collection as `GET /reference_data/map_of_sets/{name}` returns it. */
function liveMapOfSets(name: string, elementType: string, data: Record<string, string[]>) {
  return ok({
    name,
    element_type: elementType,
    data: Object.fromEntries(
      Object.entries(data).map(([key, values]) => [key, values.map((value) => ({ value }))]),
    ),
  })
}

test('reference-map-of-sets deploy: creates a collection that does not exist and records it as created', async () => {
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({}), ok({}), ok({})])
  try {
    const result = await deploy(deployContext([ADMIN_USERS]))

    assertQRadarHeaders(assert, calls)
    assert.equal(pathOf(calls[0]), '/reference_data/map_of_sets/Admin%20Users', 'the name is URL-encoded')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].range, 'items=0-9999', 'the whole pair list is read, not the first page')

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), '/reference_data/map_of_sets?name=Admin%20Users&element_type=ALN')
    assert.deepEqual(
      calls.slice(2).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/map_of_sets/Admin%20Users?key=finance&value=alice',
        'POST /reference_data/map_of_sets/Admin%20Users?key=finance&value=bob',
        'POST /reference_data/map_of_sets/Admin%20Users?key=ops&value=carol',
      ],
      'every declared (key, value) pair is written, one call each',
    )

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'Admin Users')
    assert.equal(entries[0].existed, false, 'a collection this deploy created must be marked not pre-existing')
    assert.deepEqual(entries[0].priorPairs, [])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: updating an existing collection records the LIVE prior pairs, not the desired ones', async () => {
  // The live collection deliberately differs from the canvas in BOTH
  // directions: it is missing one declared pair and carries one the canvas does
  // not declare. A handler that recorded the canvas pairs as "prior" would look
  // correct on a no-op deploy and lose the operator's data on rollback — here,
  // the membership of an access group.
  const { calls, restore } = recordFetch([
    liveMapOfSets('Admin Users', 'ALN', { finance: ['alice'], ops: ['carol', 'mallory'] }),
    ok({}),
    ok({}),
  ])
  try {
    const result = await deploy(deployContext([ADMIN_USERS]))

    assert.deepEqual(
      calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/map_of_sets/Admin%20Users?key=finance&value=bob',
        'DELETE /reference_data/map_of_sets/Admin%20Users/ops/mallory',
      ],
      'reconcile adds the missing pair and removes the undeclared one',
    )

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.deepEqual(
      entries[0].priorPairs,
      [
        ['finance', 'alice'],
        ['ops', 'carol'],
        ['ops', 'mallory'],
      ],
      'rollback state is what was live before the write',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: a pair already present is left alone', async () => {
  // Reconcile is diff-based: re-writing every declared pair on every deploy
  // would churn the console's reference-data audit trail for no change.
  const { calls, restore } = recordFetch([
    liveMapOfSets('Admin Users', 'ALN', { finance: ['alice', 'bob'], ops: ['carol'] }),
  ])
  try {
    const result = await deploy(deployContext([ADMIN_USERS]))

    assert.equal(writeCalls(calls).length, 0, 'a collection already in the declared state needs no write')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

// A collection whose keys AND values contain spaces. Deploy diffs against live
// by joining each (key, value) into ONE composite string, so the separator has
// to be a character that cannot occur in either half — it is a NUL
// (`deploy.ts:23`), not the space it looks like in an editor. These two tests
// pin that: with a space separator the first would write an invented pair and
// the second would leave an undeclared pair in the customer's console.
const WATCHLISTS = item('Watchlists', {
  name: 'Watchlists',
  elementType: 'ALN',
  entries: 'Threat Feed = evil.example, Acme Corp',
})

test('reference-map-of-sets deploy: a key or value containing a space survives the composite-key round trip', async () => {
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({}), ok({})])
  try {
    const result = await deploy(deployContext([WATCHLISTS]))

    assert.deepEqual(
      calls.slice(2).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/map_of_sets/Watchlists?key=Threat%20Feed&value=evil.example',
        'POST /reference_data/map_of_sets/Watchlists?key=Threat%20Feed&value=Acme%20Corp',
      ],
      'both halves of the pair reach the console whole',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: a live pair that only LOOKS declared is still removed', async () => {
  // Live holds key "Threat" / value "Feed evil.example" — a different pair that
  // collapses to the same string as the declared one if the two halves are
  // joined with a space. It is not declared, so it must be deleted, and the
  // declared pair must still be written.
  const { calls, restore } = recordFetch([
    liveMapOfSets('Watchlists', 'ALN', { Threat: ['Feed evil.example'] }),
    ok({}),
    ok({}),
    ok({}),
  ])
  try {
    const result = await deploy(
      deployContext([item('Watchlists', { name: 'Watchlists', elementType: 'ALN', entries: 'Threat Feed = evil.example' })]),
    )

    const writes = calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`)
    assert.ok(
      writes.includes('POST /reference_data/map_of_sets/Watchlists?key=Threat%20Feed&value=evil.example'),
      `the declared pair must be written: ${writes.join(', ')}`,
    )
    assert.ok(
      writes.includes('DELETE /reference_data/map_of_sets/Watchlists/Threat/Feed%20evil.example'),
      `the undeclared pair must be removed: ${writes.join(', ')}`,
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: refuses a collection whose live element type differs, without writing', async () => {
  // The element type is immutable in QRadar; pushing ALN values into an IP
  // collection would half-succeed and leave a mixed collection behind.
  const { calls, restore } = recordFetch([liveMapOfSets('Admin Users', 'IP', { finance: ['10.0.0.1'] })])
  try {
    const result = await deploy(deployContext([ADMIN_USERS]))

    assert.equal(writeCalls(calls).length, 0, 'an immutable-type clash must not write anything')
    assert.equal(result.success, false)
    assert.match(String(result.message), /element type is immutable/)
    assert.deepEqual(
      (result.rollbackData as { entries: unknown[] }).entries,
      [],
      'a refused collection records no rollback entry',
    )
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: an unreadable collection fails rather than being created a second time', async () => {
  // A 500 means "I do not know whether this collection exists". Treating it as
  // 404 and creating would either collide or duplicate; this asserts the
  // handler makes no create attempt at all.
  const { calls, restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await deploy(deployContext([ADMIN_USERS]))

    assert.equal(calls.length, 1, 'the handler stops at the failed read')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /Internal server error/)
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: an unreachable console is a failed result, not a thrown error', async () => {
  const { calls, restore } = recordFetch([transportFailure()])
  try {
    const result = await deploy(deployContext([ADMIN_USERS]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /ENOTFOUND/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: a create the console refuses is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([notFound(), forbidden()])
  try {
    const result = await deploy(deployContext([ADMIN_USERS]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /required capability/)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [], 'nothing was created')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: a pair the console rejects fails the deploy but keeps the rollback entry', async () => {
  const { restore } = recordFetch([
    liveMapOfSets('Admin Users', 'ALN', { finance: ['alice'] }),
    qradarError(422, 'Value does not match the element type'),
  ])
  try {
    const result = await deploy(deployContext([ADMIN_USERS]))

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the collection was touched, so rollback must know its prior state')
    assert.deepEqual(entries[0].priorPairs, [['finance', 'alice']])
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: removes a collection it created before and no longer declares', async () => {
  const { calls, restore } = routeFetch(
    [
      { url: /\/reference_data\/map_of_sets\/Admin%20Users$/, method: 'GET', respond: notFound() },
      { url: /\/reference_data\/map_of_sets\?name=/, method: 'POST', respond: ok({}) },
      { url: /\/reference_data\/map_of_sets\/Retired%20Group$/, method: 'DELETE', respond: ACCEPTED },
    ],
    ok({}),
  )
  try {
    const result = await deploy(
      deployContext([ADMIN_USERS], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Group', existed: false, elementType: 'ALN', priorPairs: [] },
            { name: 'Operator Owned', existed: true, elementType: 'ALN', priorPairs: [['a', '1']] },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, ['/reference_data/map_of_sets/Retired%20Group'])
    assert.equal(
      deletes.some((p) => p.includes('Operator%20Owned')),
      false,
      'a collection that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [])
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: reads the canvas item name when no name field is set', async () => {
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({})])
  try {
    await deploy(deployContext([item('Fallback Group', { elementType: 'aln', entries: 'k = v' })]))

    assert.equal(pathOf(calls[0]), '/reference_data/map_of_sets/Fallback%20Group')
    assert.equal(
      pathOf(calls[1]),
      '/reference_data/map_of_sets?name=Fallback%20Group&element_type=ALN',
      'the element type is upper-cased before it is sent',
    )
  } finally {
    restore()
  }
})

test('reference-map-of-sets deploy: canvas snapshots that carry only `sections` are read too', async () => {
  // The platform still ships the deprecated `sections` alias; the extractor
  // falls back to it, and a fixture that only sets `items` would never prove it.
  const ctx = deployContext([])
  const sectionsOnly = { ...canvas([ADMIN_USERS]), items: undefined as unknown as [] }
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({}), ok({}), ok({})])
  try {
    await deploy({ ...ctx, canvas: sectionsOnly } as typeof ctx)

    assert.ok(calls.length > 0, 'a sections-only canvas must still deploy')
    assert.equal(pathOf(calls[0]), '/reference_data/map_of_sets/Admin%20Users')
  } finally {
    restore()
  }
})
