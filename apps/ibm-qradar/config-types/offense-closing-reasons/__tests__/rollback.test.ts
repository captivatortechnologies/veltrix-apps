// rollback for offense-closing-reasons.
//
// This handler makes no console call at all, so the shared rollback contract
// does not apply to it. The API exposes create and read only — no update, no
// delete — so there is genuinely nothing to undo, and the handler's job is to
// say so honestly rather than report a clean rollback the operator did not get.
//
// What matters in production: the message has to name how many reasons this
// deploy left behind, because every one of them stays in the analyst's offence
// close dialog until someone removes it through the QRadar UI.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { leaksToken, recordFetch, rollbackContext } from '../../../lib/__tests__/fakeQRadar'

const CREATED_A = { itemId: 'item-tuned', text: 'False Positive - Tuned', existed: false, id: 40 }
const CREATED_B = { itemId: 'item-auto', text: 'Closed by automation', existed: false, id: 41 }
const PRE_EXISTING = { itemId: 'item-policy', text: 'Closed by policy', existed: true, id: 7 }

test('offense-closing-reasons rollback: never calls the console, whatever the deploy recorded', async () => {
  // A DELETE here would 404 or, worse, hit some other endpoint. Every shape the
  // platform can hand this handler must stay off the network.
  const shapes: unknown[] = [
    undefined,
    {},
    { entries: [] },
    { entries: 'not-an-array' },
    { entries: [CREATED_A, CREATED_B, PRE_EXISTING] },
  ]

  for (const data of shapes) {
    const { calls, restore } = recordFetch([])
    try {
      const result = await rollback(rollbackContext(data))

      assert.equal(calls.length, 0, `rollbackData ${JSON.stringify(data ?? null)} must produce no call`)
      assert.equal(result.success, true, 'nothing to undo is not a failure')
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  }
})

test('offense-closing-reasons rollback: names the count of reasons that cannot be removed via the API', async () => {
  // Under-reporting here is the failure that costs: the operator believes the
  // console is back to its prior state and never retires the extra reasons.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED_A, CREATED_B, PRE_EXISTING] }))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /append-only/)
    assert.match(
      String(result.message),
      /2 reason\(s\) created by this deploy cannot be removed/,
      'only the reasons this deploy CREATED are unrecoverable; the pre-existing one was never touched',
    )
  } finally {
    restore()
  }
})

test('offense-closing-reasons rollback: says there is nothing to roll back when it created nothing', async () => {
  for (const data of [undefined, { entries: [] }, { entries: [PRE_EXISTING] }]) {
    const { restore } = recordFetch([])
    try {
      const result = await rollback(rollbackContext(data))

      assert.equal(result.success, true)
      assert.match(String(result.message), /No closing reasons to roll back \(this type is append-only\)/)
    } finally {
      restore()
    }
  }
})

test('offense-closing-reasons rollback: reports the count even with no credential configured', async () => {
  // There is no credential guard because there is no call to guard. The honest
  // message about unremovable reasons must still reach the operator.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED_A] }, { credential: null }))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 reason\(s\) created by this deploy cannot be removed/)
  } finally {
    restore()
  }
})
