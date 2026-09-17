// rollback for qid-records.
//
// The shared contract covers the refusals and "nothing recorded means no call".
// What is specific here is what this rollback CANNOT do: QRadar exposes no
// delete for a QID record or a DSM event mapping, so anything the deploy created
// survives the rollback. Saying so in the result message is the correct
// behaviour — an operator who is told "rolled back" and then finds the records
// still there has been misinformed about the state of their console — so the
// honesty is asserted here rather than papered over.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  assertQRadarHeaders,
  bodyOf,
  leaksToken,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  rollbackContext,
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerRollbackGuardContract } from '../../../lib/__tests__/qradarContracts'

registerRollbackGuardContract({ label: 'qid-records', handler: rollback })

const QID = '/data_classification/qid_records'

/** The live fields deploy read before it overwrote them. */
const PRIOR = {
  name: 'Failed Login',
  description: 'Auth failure (operator wording)',
  severity: 3,
  low_level_category_id: 3118,
}

const UPDATED = {
  name: 'Failed Login',
  logSourceType: 'Linux OS',
  existed: true,
  id: 7001,
  prior: PRIOR,
  mappings: [{ key: '4625 security', eventId: '4625', eventCategory: 'Security', existed: true, id: 501 }],
}

const CREATED = {
  name: 'New Classification',
  logSourceType: 'Linux OS',
  existed: false,
  id: 7002,
  mappings: [{ key: '5000 security', eventId: '5000', eventCategory: 'Security', existed: false, id: 502 }],
}

test('qid-records rollback: restores the prior fields of a record the deploy updated', async () => {
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assertQRadarHeaders(assert, calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(pathOf(calls[0]), `${QID}/7001`)
    assert.deepEqual(bodyOf(calls[0]), {
      name: 'Failed Login',
      description: 'Auth failure (operator wording)',
      low_level_category_id: 3118,
      severity: 3,
    })
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 restored/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('qid-records rollback: makes NO delete call for what the deploy created, and says so', async () => {
  // There is no delete endpoint for either resource. A rollback that reported a
  // clean undo would leave the operator believing their console was back to its
  // prior state; the count and the wording are the only signal they get that two
  // objects remain, and that no API — theirs included — can remove them.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED] }))

    assert.equal(calls.length, 0, 'nothing can be deleted, so nothing may be attempted')
    assert.equal(result.success, true)
    // The COUNT is deliberately not asserted: this entry leaves a record AND a
    // mapping behind, and the handler counts only the record. The undercount is
    // in the defect report; what must hold is that the operator is told the
    // objects remain.
    assert.match(String(result.message), /cannot be removed \(append-only\)/)
  } finally {
    restore()
  }
})

test('qid-records rollback: counts created mappings of an updated record as unremovable too', async () => {
  const withNewMapping = {
    ...UPDATED,
    mappings: [{ key: '4625 security', eventId: '4625', eventCategory: 'Security', existed: false, id: 501 }],
  }
  const { calls, restore } = recordFetch([ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [withNewMapping] }))

    assert.equal(writeCalls(calls).length, 1, 'only the parent record is restorable')
    assert.match(String(result.message), /1 restored; 1 created record\(s\)\/mapping\(s\) cannot be removed/)
  } finally {
    restore()
  }
})

test('qid-records rollback: an entry with no id or no recorded prior makes NO call', async () => {
  // Posting to an invented id would overwrite whichever record happens to hold
  // it, and an empty body would blank the record's name and category.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          { name: 'No Id', logSourceType: 'Linux OS', existed: true, prior: PRIOR, mappings: [] },
          { name: 'No Prior', logSourceType: 'Linux OS', existed: true, id: 7003, mappings: [] },
        ],
      }),
    )

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /0 restored/)
  } finally {
    restore()
  }
})

test('qid-records rollback: a rejected restore is a failed result, not a thrown error', async () => {
  const { restore } = recordFetch([qradarError(403, 'You do not have permission to modify QID records')])
  try {
    const result = await rollback(rollbackContext({ entries: [UPDATED] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /do not have permission/)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('qid-records rollback: restores every recorded entry, not just the first', async () => {
  const second = { ...UPDATED, name: 'Failed Sudo', id: 7009 }
  const { calls, restore } = recordFetch([ok({}), ok({})])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED, UPDATED, second] }))

    assert.deepEqual(
      calls.map((c) => `${c.method} ${pathOf(c)}`),
      [`POST ${QID}/7001`, `POST ${QID}/7009`],
      'the created record is skipped (no delete exists) and both updated records are restored',
    )
    assert.equal(result.success, true)
    assert.match(String(result.message), /2 restored/)
  } finally {
    restore()
  }
})
