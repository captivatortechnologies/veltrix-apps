// rollback for reference-tables.
//
// The shared contract covers the refusals (no credential, no console host,
// nothing recorded). What is specific here: a table this deploy created is
// deleted; a table it only updated is reconciled back to the cells deploy
// captured — which means re-reading the live table first, because cells may
// have changed again since.
//
// NOTE ON FIXTURES: every outer and inner key below is a single token.
// `rollback.ts:15` declares its composite-id separator as a LITERAL SPACE where
// `deploy.ts:22` uses a NUL, and splits the id back apart at line 44 — so a key
// containing a space is torn in two and restored into a cell that does not
// exist. That path is deliberately left unasserted rather than pinned as
// correct; it is in the defect report.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  forbidden,
  leaksToken,
  notFound,
  ok,
  pathOf,
  recordFetch,
  rollbackContext,
  serverError,
  transportFailure,
  writeCalls,
  assertQRadarHeaders,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

registerRollbackGuardContract({ label: 'reference-tables', handler: rollback })

const UPDATED = {
  name: 'User Roles',
  existed: true,
  elementType: 'ALN',
  priorCells: [
    { outerKey: 'alice', innerKey: 'role', value: 'operator' },
    { outerKey: 'bob', innerKey: 'role', value: 'left-the-company' },
  ],
}

const CREATED = { name: 'New Table', existed: false, elementType: 'ALN', priorCells: [] }

function liveTable(name: string, rows: Record<string, Record<string, string>>) {
  return ok({
    name,
    element_type: 'ALN',
    data: Object.fromEntries(
      Object.entries(rows).map(([outer, inner]) => [
        outer,
        Object.fromEntries(Object.entries(inner).map(([col, value]) => [col, { value }])),
      ]),
    ),
  })
}

test('reference-tables rollback: restores exactly the cells deploy captured', async () => {
  // Live holds the cell the deploy overwrote, is missing the row the deploy
  // removed, and carries a row the deploy added. Rollback must put the first
  // two back and take the third away.
  const { calls, restore } = recordFetch([
    liveTable('User Roles', { alice: { role: 'admin' }, carol: { role: 'auditor' } }),
    ok({}),
    ok({}),
    ok({}),
  ])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls[0].method, 'GET')
    assert.equal(pathOf(calls[0]), '/reference_data/tables/User%20Roles')
    assert.equal(calls[0].range, 'items=0-9999')
    assert.deepEqual(
      calls.slice(1).map((c) => `${c.method} ${pathOf(c)}`),
      [
        'POST /reference_data/tables/User%20Roles?outer_key=alice&inner_key=role&value=operator',
        'POST /reference_data/tables/User%20Roles?outer_key=bob&inner_key=role&value=left-the-company',
        'DELETE /reference_data/tables/User%20Roles/carol/role',
      ],
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-tables rollback: a cell already at its prior value is not rewritten', async () => {
  const { calls, restore } = recordFetch([
    liveTable('User Roles', { alice: { role: 'operator' }, bob: { role: 'left-the-company' } }),
  ])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(writeCalls(calls).length, 0, 'a table already in its prior state needs no write')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reference-tables rollback: deletes a table the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), '/reference_data/tables/New%20Table')
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('reference-tables rollback: a table already gone is not an error', async () => {
  // 404 is a known answer: the object rollback would delete is already absent,
  // which is the state it was trying to reach.
  const { restore } = recordFetch([notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('reference-tables rollback: a read it cannot perform fails rather than restoring nothing', async () => {
  // Without the live cells there is no safe reconcile, so the entry must be
  // reported as failed — not silently skipped as "already correct".
  const { calls, restore } = recordFetch([serverError('Internal server error reading reference data')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(writeCalls(calls).length, 0, 'an unreadable table must not be written blind')
    assert.equal(result.success, false)
    assert.match(String(result.message), /Internal server error/)
  } finally {
    restore()
  }
})

test('reference-tables rollback: an unreachable console is a failed result, not a thrown error', async () => {
  const { calls, restore } = recordFetch([transportFailure()])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /ENOTFOUND/)
  } finally {
    restore()
  }
})

test('reference-tables rollback: a rejected delete is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([forbidden('You do not have permission to delete reference data')])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('reference-tables rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([
    ACCEPTED,
    liveTable('User Roles', { alice: { role: 'operator' }, bob: { role: 'left-the-company' } }),
  ])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      ['DELETE /reference_data/tables/New%20Table', 'GET /reference_data/tables/User%20Roles'],
      'the created table is deleted and the updated table is re-read',
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
