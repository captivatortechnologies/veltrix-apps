// ============================================================================
// rollback for ISC access profiles.
//
// Rollback can only undo what deploy wrote down: a profile deploy UPDATED is
// patched back to the prior snapshot, one it CREATED is deleted, and an entry
// carrying neither must make no call at all — writing an invented state over a
// live access profile hands out or withdraws real entitlements.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { TOKEN, bodyOf, ok, recordFetch, rollbackContext, writeCalls } from '../../../lib/__tests__/fakeIsc'
import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

const UPDATED_ENTRY = { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR }

registerRollbackContract({
  label: 'access-profiles',
  handler: rollback,
  restore: {
    entry: UPDATED_ENTRY,
    method: 'PATCH',
    path: `/v3/access-profiles/${LIVE_ID}`,
    bodyIncludes: ['Legacy description nobody updated', 'id-owner-departed', 'ent-db-read-only'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'ap-created-by-us' },
    method: 'DELETE',
    path: '/v3/access-profiles/ap-created-by-us',
  },
  unrecoverable: [
    // Created, but the vendor response carried no id — nothing to delete.
    { name: NAME, existed: false },
    // Pre-existing, but deploy never captured what it looked like.
    { name: NAME, existed: true, id: LIVE_ID },
  ],
})

test('access-profiles rollback: restores the prior entitlement set exactly', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    await rollback(rollbackContext({ entries: [UPDATED_ENTRY] }))

    const ops = bodyOf(writeCalls(calls)[0]) as Array<{ op: string; path: string; value: unknown }>
    assert.deepEqual(ops.find((o) => o.path === '/entitlements')?.value, [
      { type: 'ENTITLEMENT', id: 'ent-db-read-only' },
    ])
    assert.equal(ops.find((o) => o.path === '/enabled')?.value, false)
    assert.deepEqual(ops.find((o) => o.path === '/owner')?.value, { type: 'IDENTITY', id: 'id-owner-departed' })
  } finally {
    restore()
  }
})
