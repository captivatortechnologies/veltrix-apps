// driftDetect for offense-closing-reasons.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here: identity is the reason TEXT and the only question is presence,
// so the load-bearing assertion is that a soft-deleted (`is_deleted`) row does
// not read as present — a retired reason is gone from the analyst's close
// dialog even though the list still returns it.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  driftContext,
  item,
  list,
  pathOf,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

const PATH = '/siem/offense_closing_reasons'

const TUNED = item('False Positive - Tuned', { text: 'False Positive - Tuned' }, 'item-tuned')
const AUTOMATION = item('Closed by automation', { text: 'Closed by automation' }, 'item-auto')

registerDriftGuardContract({ label: 'offense-closing-reasons', handler: driftDetect, sampleItems: [TUNED] })

test('offense-closing-reasons driftDetect: reports in sync when every declared reason is live', async () => {
  const { calls, restore } = recordFetch([
    list([
      { id: 7, text: 'False Positive - Tuned' },
      { id: 8, text: 'Closed by automation' },
      { id: 9, text: 'A reason nobody declared' },
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([TUNED, AUTOMATION]))

    assert.equal(calls.length, 1, 'one list read serves every declared reason')
    assert.equal(pathOf(calls[0]), PATH)
    assert.equal(calls[0].range, 'items=0-9999', 'a partial page would report later reasons as deleted')
    assert.equal(result.hasDrift, false, 'an undeclared extra reason is not drift for this type')
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('offense-closing-reasons driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
  // canvas would look for that text and report the real reason as deleted.
  const { restore } = recordFetch([list([{ id: 7, text: 'False Positive - Tuned' }])])
  try {
    const result = await driftDetect(driftContext([TUNED]))

    assert.equal(result.hasDrift, false, 'the decoy canvas item must not be compared')
  } finally {
    restore()
  }
})

test('offense-closing-reasons driftDetect: reports a reason removed in the console as critical', async () => {
  // A 200 with a list that does not contain it is a real answer.
  const { restore } = recordFetch([list([{ id: 8, text: 'Closed by automation' }])])
  try {
    const result = await driftDetect(driftContext([TUNED, AUTOMATION]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'False Positive - Tuned', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(result.checked, undefined, 'an answered read did check')
  } finally {
    restore()
  }
})

test('offense-closing-reasons driftDetect: a soft-deleted reason reports as absent, not present', async () => {
  // QRadar retires a reason by flagging it rather than removing the row.
  // Counting it as present would report the console in sync while analysts can
  // no longer pick the reason the canvas declares.
  const { restore } = recordFetch([list([{ id: 7, text: 'False Positive - Tuned', is_deleted: true }])])
  try {
    const result = await driftDetect(driftContext([TUNED]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'False Positive - Tuned', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('offense-closing-reasons driftDetect: matches the live reason text case-insensitively', async () => {
  const { restore } = recordFetch([list([{ id: 7, text: 'FALSE POSITIVE - TUNED' }])])
  try {
    const result = await driftDetect(driftContext([TUNED]))

    assert.equal(result.hasDrift, false, 'a case difference is not a deleted reason')
  } finally {
    restore()
  }
})

test('offense-closing-reasons driftDetect: an empty deployed config reports in sync and writes nothing', async () => {
  const { calls, restore } = recordFetch([list([])])
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined)
  } finally {
    restore()
  }
})

// NOTE: `listClosingReasons` (deploy.ts:25) returns [] when the list read fails,
// so a 500 makes every declared reason report `actual: 'absent', severity:
// 'critical'` with no `checked: false`. That path is deliberately unasserted —
// it is a defect, not a contract.
