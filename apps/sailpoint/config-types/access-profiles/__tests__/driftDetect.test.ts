// ============================================================================
// driftDetect for ISC access profiles.
//
// The drift that matters is someone widening a profile in the ISC admin console:
// adding an entitlement, moving the owner, or enabling a profile that was parked.
// Entitlements are compared as a set, so the order ISC happens to return them in
// must not read as drift.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { TOKEN, driftContext, listPage, recordFetch, writeCalls } from '../../../lib/__tests__/fakeIsc'
import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncProfile, profileItem } from './fixtures'

registerCollectionDriftContract({
  label: 'access-profiles',
  handler: driftDetect,
  listPath: '/v3/access-profiles',
  item: profileItem(),
  matchingLive: inSyncProfile(),
  driftedLive: inSyncProfile({ enabled: false }),
  driftedField: `${NAME}.enabled`,
  absentField: NAME,
})

test('access-profiles driftDetect: an entitlement added in the console is drift', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    listPage([inSyncProfile({ entitlements: [{ id: 'ent-db-read' }, { id: 'ent-db-write' }, { id: 'ent-db-admin' }] })]),
  ])
  try {
    const result = await driftDetect(driftContext([profileItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === `${NAME}.entitlements`)
    assert.ok(diff, 'a widened entitlement set must be reported')
    assert.equal(diff.actual, 'ent-db-admin,ent-db-read,ent-db-write')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('access-profiles driftDetect: a moved source is reported', async () => {
  const { restore } = recordFetch([TOKEN, listPage([inSyncProfile({ source: { id: 'src-somewhere-else' } })])])
  try {
    const result = await driftDetect(driftContext([profileItem()]))

    assert.equal(result.hasDrift, true)
    assert.ok(result.diffs.some((d) => d.field === `${NAME}.source`))
  } finally {
    restore()
  }
})
