// deploy for reference-tables.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// the classic name-keyed reference-data flow for a two-level table: GET the
// table by name, create it on a 404 (with its typed columns), reconcile its
// outer_key/inner_key cells to exactly the declared set, and record the LIVE
// prior cells so rollback can put them back. The element type is immutable, so
// a live type mismatch must refuse rather than overwrite.

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

const USER_ROLES = item('User Roles', {
  name: 'User Roles',
  elementType: 'ALN',
  columns: 'srcip: IP\nrole: ALN',
  cells: 'alice | srcip = 10.0.0.1\nalice | role = admin\ncarol | role = auditor',
})

registerDeployGuardContract({ label: 'reference-tables', handler: deploy, sampleItems: [USER_ROLES] })

/** A live table as `GET /reference_data/tables/{name}` returns it: outer -> inner -> value. */
function liveTable(name: string, elementType: string, rows: Record<string, Record<string, string>>) {
  return ok({
    name,
    element_type: elementType,
    data: Object.fromEntries(
      Object.entries(rows).map(([outer, inner]) => [
        outer,
        Object.fromEntries(Object.entries(inner).map(([col, value]) => [col, { value }])),
      ]),
    ),
  })
}

test('reference-tables deploy: creates a table that does not exist, with its typed columns', async () => {
  // key_name_types is only honoured at creation, so a create that dropped it
  // would leave every column at the table's default element type with nothing
  // in the result saying so.
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({}), ok({}), ok({})])
  try {
    const result = await deploy(deployContext([USER_ROLES]))

    assertQRadarHeaders(assert, calls)
    assert.equal(pathOf(calls[0]), '/reference_data/tables/User%20Roles', 'the table name is URL-encoded')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].range, 'items=0-9999', 'the whole cell list is read, not the first page')

    assert.equal(calls[1].method, 'POST')
    assert.equal(
      pathOf(calls[1]),
      `/reference_data/tables?name=User%20Roles&element_type=ALN&key_name_types=${encodeURIComponent(
        JSON.stringify({ srcip: 'IP', role: 'ALN' }),
      )}`,
    )
    assert.deepEqual(
      calls.slice(2).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/tables/User%20Roles?outer_key=alice&inner_key=srcip&value=10.0.0.1',
        'POST /reference_data/tables/User%20Roles?outer_key=alice&inner_key=role&value=admin',
        'POST /reference_data/tables/User%20Roles?outer_key=carol&inner_key=role&value=auditor',
      ],
    )

    assert.equal(result.success, true)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'User Roles')
    assert.equal(entries[0].existed, false, 'a table this deploy created must be marked not pre-existing')
    assert.deepEqual(entries[0].priorCells, [])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-tables deploy: a table with no typed columns is created without key_name_types', async () => {
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({})])
  try {
    await deploy(
      deployContext([item('Plain Table', { name: 'Plain Table', elementType: 'ALN', cells: 'a | b = c' })]),
    )

    assert.equal(pathOf(calls[1]), '/reference_data/tables?name=Plain%20Table&element_type=ALN')
  } finally {
    restore()
  }
})

test('reference-tables deploy: updating an existing table records the LIVE prior cells, not the desired ones', async () => {
  // The live table deliberately differs from the canvas in BOTH directions: one
  // declared cell is missing live, one live cell the canvas does not declare,
  // and one declared cell holds a different value. A handler that recorded the
  // canvas cells as "prior" would look correct on a no-op deploy and lose the
  // operator's data on rollback.
  const { calls, restore } = recordFetch([
    liveTable('User Roles', 'ALN', {
      alice: { srcip: '10.0.0.1', role: 'operator' },
      bob: { role: 'left-the-company' },
    }),
    ok({}),
    ok({}),
    ok({}),
  ])
  try {
    const result = await deploy(deployContext([USER_ROLES]))

    assert.deepEqual(
      calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/tables/User%20Roles?outer_key=alice&inner_key=role&value=admin',
        'POST /reference_data/tables/User%20Roles?outer_key=carol&inner_key=role&value=auditor',
        'DELETE /reference_data/tables/User%20Roles/bob/role',
      ],
      'the matching cell is left alone, the differing one is rewritten, the undeclared one removed',
    )

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.deepEqual(
      entries[0].priorCells,
      [
        { outerKey: 'alice', innerKey: 'srcip', value: '10.0.0.1' },
        { outerKey: 'alice', innerKey: 'role', value: 'operator' },
        { outerKey: 'bob', innerKey: 'role', value: 'left-the-company' },
      ],
      'rollback state is what was live before the write',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

// A table whose keys contain spaces. Deploy diffs against live by joining each
// (outer key, inner key) into ONE composite id, so the separator has to be a
// character that cannot occur in either half — it is a NUL (`deploy.ts:22`),
// not the space it looks like in an editor. With a space separator the second
// test below would leave an undeclared cell in the customer's console and skip
// the declared one.
const ASSET_OWNERS = item('Asset Owners', {
  name: 'Asset Owners',
  elementType: 'ALN',
  cells: 'Prod Web | owner = platform team',
})

test('reference-tables deploy: keys and values containing spaces reach the console whole', async () => {
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({})])
  try {
    const result = await deploy(deployContext([ASSET_OWNERS]))

    assert.equal(
      pathOf(calls[2]),
      '/reference_data/tables/Asset%20Owners?outer_key=Prod%20Web&inner_key=owner&value=platform%20team',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-tables deploy: a live cell that only LOOKS declared is still removed', async () => {
  // Live holds outer key "Prod" / inner key "Web owner" — a different cell that
  // collapses to the same composite id as the declared one if the two halves
  // are joined with a space. It is not declared, so it must be deleted, and the
  // declared cell must still be written.
  const { calls, restore } = recordFetch([
    liveTable('Asset Owners', 'ALN', { Prod: { 'Web owner': 'platform team' } }),
    ok({}),
    ok({}),
  ])
  try {
    const result = await deploy(deployContext([ASSET_OWNERS]))

    assert.deepEqual(
      calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/tables/Asset%20Owners?outer_key=Prod%20Web&inner_key=owner&value=platform%20team',
        'DELETE /reference_data/tables/Asset%20Owners/Prod/Web%20owner',
      ],
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-tables deploy: refuses a table whose live element type differs, without writing', async () => {
  // The element type is immutable in QRadar; pushing ALN values into an IP
  // table would half-succeed and leave a mixed table behind.
  const { calls, restore } = recordFetch([liveTable('User Roles', 'IP', { alice: { srcip: '10.0.0.1' } })])
  try {
    const result = await deploy(deployContext([USER_ROLES]))

    assert.equal(writeCalls(calls).length, 0, 'an immutable-type clash must not write anything')
    assert.equal(result.success, false)
    assert.match(String(result.message), /element type is immutable/)
    assert.deepEqual(
      (result.rollbackData as { entries: unknown[] }).entries,
      [],
      'a refused table records no rollback entry',
    )
  } finally {
    restore()
  }
})

test('reference-tables deploy: an unreadable table fails rather than being created a second time', async () => {
  // A 500 means "I do not know whether this table exists". Treating it as 404
  // and creating would either collide or duplicate; this asserts the handler
  // makes no create attempt at all.
  const { calls, restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await deploy(deployContext([USER_ROLES]))

    assert.equal(calls.length, 1, 'the handler stops at the failed read')
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /Internal server error/)
  } finally {
    restore()
  }
})

test('reference-tables deploy: an unreachable console is a failed result, not a thrown error', async () => {
  const { calls, restore } = recordFetch([transportFailure()])
  try {
    const result = await deploy(deployContext([USER_ROLES]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /ENOTFOUND/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-tables deploy: a create the console refuses is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([notFound(), forbidden()])
  try {
    const result = await deploy(deployContext([USER_ROLES]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /required capability/)
    assert.deepEqual((result.rollbackData as { entries: unknown[] }).entries, [], 'nothing was created')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-tables deploy: a cell the console rejects fails the deploy but keeps the rollback entry', async () => {
  const { restore } = recordFetch([
    liveTable('User Roles', 'ALN', { alice: { srcip: '10.0.0.1' } }),
    qradarError(422, 'Value does not match the element type'),
    ok({}),
  ])
  try {
    const result = await deploy(deployContext([USER_ROLES]))

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1, 'the table was touched, so rollback must know its prior state')
    assert.deepEqual(entries[0].priorCells, [{ outerKey: 'alice', innerKey: 'srcip', value: '10.0.0.1' }])
  } finally {
    restore()
  }
})

test('reference-tables deploy: removes a table it created before and no longer declares', async () => {
  const { calls, restore } = routeFetch(
    [
      { url: /\/reference_data\/tables\/User%20Roles$/, method: 'GET', respond: notFound() },
      { url: /\/reference_data\/tables\?name=/, method: 'POST', respond: ok({}) },
      { url: /\/reference_data\/tables\/Retired%20Table$/, method: 'DELETE', respond: ACCEPTED },
    ],
    ok({}),
  )
  try {
    const result = await deploy(
      deployContext([USER_ROLES], {
        priorRollbackData: {
          entries: [
            { name: 'Retired Table', existed: false, elementType: 'ALN', priorCells: [] },
            {
              name: 'Operator Owned',
              existed: true,
              elementType: 'ALN',
              priorCells: [{ outerKey: 'a', innerKey: 'b', value: 'c' }],
            },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, ['/reference_data/tables/Retired%20Table'])
    assert.equal(
      deletes.some((p) => p.includes('Operator%20Owned')),
      false,
      'a table that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-tables deploy: an empty canvas writes nothing', async () => {
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

test('reference-tables deploy: reads the canvas item name when no name field is set', async () => {
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({})])
  try {
    await deploy(deployContext([item('Fallback Table', { elementType: 'aln', cells: 'a | b = c' })]))

    assert.equal(pathOf(calls[0]), '/reference_data/tables/Fallback%20Table')
    assert.equal(
      pathOf(calls[1]),
      '/reference_data/tables?name=Fallback%20Table&element_type=ALN',
      'the element type is upper-cased before it is sent',
    )
  } finally {
    restore()
  }
})

test('reference-tables deploy: canvas snapshots that carry only `sections` are read too', async () => {
  // The platform still ships the deprecated `sections` alias; the extractor
  // falls back to it, and a fixture that only sets `items` would never prove it.
  const ctx = deployContext([])
  const sectionsOnly = { ...canvas([USER_ROLES]), items: undefined as unknown as [] }
  const { calls, restore } = recordFetch([notFound(), ok({}), ok({}), ok({}), ok({})])
  try {
    await deploy({ ...ctx, canvas: sectionsOnly } as typeof ctx)

    assert.ok(calls.length > 0, 'a sections-only canvas must still deploy')
    assert.equal(pathOf(calls[0]), '/reference_data/tables/User%20Roles')
  } finally {
    restore()
  }
})
