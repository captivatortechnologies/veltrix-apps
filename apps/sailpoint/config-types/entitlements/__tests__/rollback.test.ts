// rollback for the ISC entitlement governance overlay.
//
// There is nothing to delete — the entitlement belongs to the source, not to this
// app — so rollback only reverts the overlay to the snapshot deploy captured:
// requestable, privileged, owner, segments and the aggregation locks. Restoring
// the desired values instead would leave a group marked requestable that nobody
// ever asked to be.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  bodyOf,
  callsWithMethod,
  notFound,
  ok,
  recordFetch,
  rollbackContext,
  writeCalls,
} from '../../../lib/__tests__/fakeIsc'
import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { ATTRIBUTE, ENTITLEMENTS, ENTITLEMENT_ID, NAME, PRIOR, SOURCE_NAME } from './fixtures'

const ENTRY = {
  sourceName: SOURCE_NAME,
  name: NAME,
  attribute: ATTRIBUTE,
  entitlementId: ENTITLEMENT_ID,
  prior: PRIOR,
}

registerRollbackContract({
  label: 'entitlements',
  handler: rollback,
  restore: {
    entry: ENTRY,
    method: 'PATCH',
    path: `${ENTITLEMENTS}/${ENTITLEMENT_ID}`,
    bodyIncludes: ['Legacy description nobody updated', 'id-owner-departed', 'seg-legacy'],
  },
})

test('entitlements rollback: puts back every governed field, locks included', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    await rollback(rollbackContext({ entries: [ENTRY] }))

    const ops = bodyOf(writeCalls(calls)[0]) as Array<{ path: string; value: unknown }>
    assert.equal(ops.find((o) => o.path === '/requestable')?.value, false)
    assert.equal(ops.find((o) => o.path === '/privileged')?.value, false)
    assert.deepEqual(ops.find((o) => o.path === '/segments')?.value, ['seg-legacy'])
    assert.deepEqual(ops.find((o) => o.path === '/manuallyUpdatedFields')?.value, {
      DISPLAY_NAME: false,
      DESCRIPTION: false,
    })
    assert.deepEqual(ops.find((o) => o.path === '/owner')?.value, { type: 'IDENTITY', id: 'id-owner-departed' })
  } finally {
    restore()
  }
})

test('entitlements rollback: never deletes the underlying entitlement', async () => {
  // The entitlement came from the source. Deleting it here would be deleting
  // something this app did not create and cannot put back.
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    await rollback(rollbackContext({ entries: [ENTRY] }))

    assert.equal(callsWithMethod(calls, 'DELETE').length, 0)
  } finally {
    restore()
  }
})

test('entitlements rollback: treats an entitlement that is already gone as nothing to undo', async () => {
  // Aggregation removes entitlements when the group disappears from the source.
  const { restore } = recordFetch([TOKEN, notFound('entitlement no longer exists')])
  try {
    const result = await rollback(rollbackContext({ entries: [ENTRY] }))

    assert.equal(result.success, true, result.message)
  } finally {
    restore()
  }
})
