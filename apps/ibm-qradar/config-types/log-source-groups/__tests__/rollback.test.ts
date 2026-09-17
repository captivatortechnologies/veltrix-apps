// rollback for log-source-groups.
//
// This handler makes no console call at all, so the shared rollback contract
// does not apply to it. The API exposes create and read only — no update, no
// delete — so there is genuinely nothing to undo, and the handler's job is to
// say so honestly rather than report a clean rollback the operator did not get.
//
// What matters in production: the message has to name how many groups this
// deploy left behind, because that is the ONLY signal anyone gets that manual
// cleanup is needed in the QRadar console.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { leaksToken, recordFetch, rollbackContext } from '../../../lib/__tests__/fakeQRadar'

const CREATED_A = { itemId: 'item-fw', name: 'Firewalls', existed: false, id: 90 }
const CREATED_B = { itemId: 'item-pan', name: 'Palo Alto', existed: false, id: 91 }
const PRE_EXISTING = { itemId: 'item-proxy', name: 'Proxies', existed: true, id: 12 }

test('log-source-groups rollback: never calls the console, whatever the deploy recorded', async () => {
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

test('log-source-groups rollback: names the count of groups that cannot be removed via the API', async () => {
  // Under-reporting here is the failure that costs: the operator believes the
  // console is back to its prior state and never cleans up the groups.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED_A, CREATED_B, PRE_EXISTING] }))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /append-only/)
    assert.match(
      String(result.message),
      /2 group\(s\) created by this deploy cannot be removed/,
      'only the groups this deploy CREATED are unrecoverable; the pre-existing one was never touched',
    )
  } finally {
    restore()
  }
})

test('log-source-groups rollback: says there is nothing to roll back when it created nothing', async () => {
  for (const data of [undefined, { entries: [] }, { entries: [PRE_EXISTING] }]) {
    const { restore } = recordFetch([])
    try {
      const result = await rollback(rollbackContext(data))

      assert.equal(result.success, true)
      assert.match(String(result.message), /No log source groups to roll back \(this type is append-only\)/)
    } finally {
      restore()
    }
  }
})

test('log-source-groups rollback: reports the count even with no credential configured', async () => {
  // There is no credential guard because there is no call to guard. The honest
  // message about unremovable groups must still reach the operator.
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [CREATED_A] }, { credential: null }))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 group\(s\) created by this deploy cannot be removed/)
  } finally {
    restore()
  }
})
