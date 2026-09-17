// rollback for resource-restrictions.
//
// The shared contract covers the refusals and "nothing recorded means no call".
// What is specific here: a restriction the deploy created is deleted, one it
// only updated is PUT back to the limits deploy captured, and the restored body
// carries ONLY the limits — re-sending a target id would move the restriction
// onto a different tenant or role.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  leaksToken,
  notFound,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  rollbackContext,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

registerRollbackGuardContract({ label: 'resource-restrictions', handler: rollback })

const RR = '/config/resource_restrictions'

const UPDATED = {
  targetType: 'tenant',
  targetName: 'Acme Corp',
  targetKey: 'tenant:acme corp',
  existed: true,
  id: '55',
  prior: { dataWindow: 86400, executionTime: 600, recordLimit: 100000 },
}

const CREATED = {
  targetType: 'role',
  targetName: 'Security Analyst',
  targetKey: 'role:security analyst',
  existed: false,
  id: '91',
}

test('resource-restrictions rollback: PUTs back exactly the limits deploy captured', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'PUT', 'this type updates with PUT, not POST')
    assert.equal(pathOf(calls[0]), `${RR}/55`)
    assert.deepEqual(
      bodyOf(calls[0]),
      { data_window: 86400, execution_time: 600, record_limit: 100000 },
      'the restore body carries only the limits — never a target id',
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('resource-restrictions rollback: deletes a restriction the deploy created', async () => {
  const { calls, restore } = recordFetch([ACCEPTED])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(pathOf(calls[0]), `${RR}/91`)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('resource-restrictions rollback: a restriction already gone is not an error', async () => {
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

test('resource-restrictions rollback: an entry with no id makes NO call', async () => {
  // The id is a string here, so a create whose response carried none records
  // `undefined`. Addressing `/config/resource_restrictions/undefined` would at
  // best 404 and at worst hit another row.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { targetType: 'role', targetName: 'No Id', targetKey: 'role:no id', existed: false },
          { targetType: 'tenant', targetName: 'Blank Id', targetKey: 'tenant:blank id', existed: true, id: '', prior: UPDATED.prior },
        ],
      }),
    )

    assert.equal(calls.length, 0, 'an entry with no id must not be acted on')
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('resource-restrictions rollback: an entry with no recorded prior limits makes NO call', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [{ targetType: 'tenant', targetName: 'Acme Corp', targetKey: 'tenant:acme corp', existed: true, id: '55' }],
      }),
    )

    assert.equal(calls.length, 0, 'an empty restore body would clear the operator’s limits')
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 deleted, 0 restored/)
  } finally {
    restore()
  }
})

test('resource-restrictions rollback: a rejected restore is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(403, 'You do not have permission to modify resource restrictions')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('resource-restrictions rollback: undoes every recorded entry, not just the first', async () => {
  const { calls, restore } = recordFetch([ACCEPTED, ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`DELETE ${RR}/91`, `PUT ${RR}/55`],
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 1 restored/)
  } finally {
    restore()
  }
})
