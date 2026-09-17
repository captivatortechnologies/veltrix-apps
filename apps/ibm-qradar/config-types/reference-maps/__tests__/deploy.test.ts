// deploy for reference-maps.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the classic name-keyed reference-data flow: GET the map by name, create it on
// a 404, reconcile its key=value entries to exactly the declared list, and
// record the LIVE prior entries so rollback can put them back. The element type
// is immutable, so a live type mismatch must refuse rather than overwrite.

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

const HOST_MAP = item('Host Map', {
  name: 'Host Map',
  elementType: 'ALN',
  entries: '10.0.0.1=web-server\n10.0.0.2=db-server',
})

registerDeployGuardContract({ label: 'reference-maps', handler: deploy, sampleItems: [HOST_MAP] })

/** A live map as `GET /reference_data/maps/{name}` returns it: data is key-keyed. */
function liveMap(name: string, elementType: string, pairs: Record<string, string>) {
  return ok({
    name,
    element_type: elementType,
    data: Object.fromEntries(Object.entries(pairs).map(([key, value]) => [key, { value }])),
  })
}

test('reference-maps deploy: creates a map that does not exist and records it as created', async () => {
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({}), ok({})])
  try {
    const result = await deploy(deployContext([HOST_MAP]))

    assertQRadarHeaders(assert, calls)
    assert.equal(pathOf(calls[0]), '/reference_data/maps/Host%20Map', 'the map name is URL-encoded')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].range, 'items=0-9999', 'the whole entry list is read, not the first page')

    assert.equal(calls[1].method, 'POST')
    assert.equal(pathOf(calls[1]), '/reference_data/maps?name=Host%20Map&element_type=ALN')
    assert.deepEqual(
      calls.slice(2).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/maps/Host%20Map?key=10.0.0.1&value=web-server',
        'POST /reference_data/maps/Host%20Map?key=10.0.0.2&value=db-server',
      ],
    )

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'Host Map')
    assert.equal(entries[0].existed, false, 'a map this deploy created must be marked not pre-existing')
    assert.deepEqual(entries[0].priorEntries, [])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-maps deploy: updating an existing map records the LIVE prior entries, not the desired ones', async () => {
  // The live map deliberately differs from the canvas in BOTH directions: it is
  // missing one declared entry and carries one the canvas does not declare. A
  // handler that recorded the canvas entries as "prior" would look correct on a
  // no-op deploy and lose the operator's data on rollback.
  const { calls, restore } = recordFetch([
    liveMap('Host Map', 'ALN', { '10.0.0.1': 'web-server', '10.0.0.9': 'added-by-hand' }),
    ok({}),
    ok({}),
  ])
  try {
    const result = await deploy(deployContext([HOST_MAP]))

    assert.deepEqual(
      calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/maps/Host%20Map?key=10.0.0.2&value=db-server',
        'DELETE /reference_data/maps/Host%20Map/10.0.0.9',
      ],
      'reconcile adds what is missing and removes what is extra',
    )

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.deepEqual(
      entries[0].priorEntries,
      [
        { key: '10.0.0.1', value: 'web-server' },
        { key: '10.0.0.9', value: 'added-by-hand' },
      ],
      'rollback state is what was live before the write',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-maps deploy: overwrites a key repointed in the console and records the value it replaced', async () => {
  // The silent-overwrite path: the key exists on both sides but the console
  // holds a different value. Without the prior value in rollback state, an
  // operator who rolled this deploy back would never get the old target back.
  const { calls, restore } = recordFetch([
    liveMap('Host Map', 'ALN', { '10.0.0.1': 'someone-repointed-this', '10.0.0.2': 'db-server' }),
    ok({}),
  ])
  try {
    const result = await deploy(deployContext([HOST_MAP]))

    assert.deepEqual(
      calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`),
      ['POST /reference_data/maps/Host%20Map?key=10.0.0.1&value=web-server'],
      'only the entry that actually differs is rewritten',
    )

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.deepEqual(entries[0].priorEntries, [
      { key: '10.0.0.1', value: 'someone-repointed-this' },
      { key: '10.0.0.2', value: 'db-server' },
    ])
  } finally {
    restore()
  }
})

test('reference-maps deploy: refuses a map whose live element type differs, without writing', async () => {
  // The element type is immutable in QRadar; pushing ALN values into an IP map
  // would half-succeed and leave a mixed map behind.
  const { calls, restore } = recordFetch([liveMap('Host Map', 'IP', { '10.0.0.1': '10.9.9.9' })])
  try {
    const result = await deploy(deployContext([HOST_MAP]))

    assert.equal(writeCalls(calls).length, 0, 'an immutable-type clash must not write anything')
    assert.equal(result.success, false)
    assert.match(String(result.message), /element type is immutable/)
    const entries = (result.rollbackData as { entries: unknown[] }).entries
    assert.deepEqual(entries, [], 'a refused map records no rollback entry')
  } finally {
    restore()
  }
})

test('reference-maps deploy: an unreadable map fails rather than being created a second time', async () => {
  // A 500 means "I do not know whether this map exists". Treating it as 404 and
  // creating would either collide or duplicate; this asserts the handler makes
  // no create attempt at all.
  const { calls, restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await deploy(deployContext([HOST_MAP]))

    assert.equal(calls.length, 1, 'the handler stops at the failed read')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /Internal server error/)
  } finally {
    restore()
  }
})

test('reference-maps deploy: an unreachable console is a failed result, not a thrown error', async () => {
  // A throw surfaces as an opaque pipeline crash; the operator needs the reason.
  const { calls, restore } = recordFetch([transportFailure()])
  try {
    const result = await deploy(deployContext([HOST_MAP]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /ENOTFOUND/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-maps deploy: a create the console refuses is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([notFound(), forbidden()])
  try {
    const result = await deploy(deployContext([HOST_MAP]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /required capability/)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [], 'nothing was created')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-maps deploy: an entry the console rejects fails the deploy but keeps the rollback entry', async () => {
  const { restore } = recordFetch([
    liveMap('Host Map', 'ALN', { '10.0.0.1': 'web-server' }),
    qradarError(422, 'Value does not match the element type'),
  ])
  try {
    const result = await deploy(deployContext([HOST_MAP]))

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the map was touched, so rollback must know its prior state')
    assert.deepEqual(entries[0].priorEntries, [{ key: '10.0.0.1', value: 'web-server' }])
  } finally {
    restore()
  }
})

test('reference-maps deploy: removes a map it created before and no longer declares', async () => {
  const { calls, restore } = routeFetch(
    [
      { url: /\/reference_data\/maps\/Host%20Map$/, method: 'GET', respond: notFound() },
      { url: /\/reference_data\/maps\?name=/, method: 'POST', respond: ok({}) },
      { url: /\/reference_data\/maps\/Retired%20Map$/, method: 'DELETE', respond: ACCEPTED },
    ],
    ok({}),
  )
  try {
    const result = await deploy(
      deployContext([HOST_MAP], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Map', existed: false, elementType: 'ALN', priorEntries: [] },
            { name: 'Operator Owned', existed: true, elementType: 'ALN', priorEntries: [{ key: 'a', value: '1' }] },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, ['/reference_data/maps/Retired%20Map'])
    assert.equal(
      deletes.some((p) => p.includes('Operator%20Owned')),
      false,
      'a map that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-maps deploy: an empty canvas writes nothing', async () => {
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

test('reference-maps deploy: reads the canvas item name when no name field is set', async () => {
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({})])
  try {
    await deploy(deployContext([item('Fallback Map', { elementType: 'aln', entries: 'k=v' })]))

    assert.equal(pathOf(calls[0]), '/reference_data/maps/Fallback%20Map')
    assert.equal(
      pathOf(calls[1]),
      '/reference_data/maps?name=Fallback%20Map&element_type=ALN',
      'the element type is upper-cased before it is sent',
    )
  } finally {
    restore()
  }
})

test('reference-maps deploy: canvas snapshots that carry only `sections` are read too', async () => {
  // The platform still ships the deprecated `sections` alias; the extractor
  // falls back to it, and a fixture that only sets `items` would never prove it.
  const ctx = deployContext([])
  const sectionsOnly = { ...canvas([HOST_MAP]), items: undefined as unknown as [] }
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({}), ok({})])
  try {
    await deploy({ ...ctx, canvas: sectionsOnly } as typeof ctx)

    assert.ok(calls.length > 0, 'a sections-only canvas must still deploy')
    assert.equal(pathOf(calls[0]), '/reference_data/maps/Host%20Map')
  } finally {
    restore()
  }
})
