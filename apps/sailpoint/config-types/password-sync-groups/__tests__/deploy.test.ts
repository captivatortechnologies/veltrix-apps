// deploy for ISC password sync groups.
//
// A password sync group decides which sources share a password. The update is a
// whole-body PUT of the source list, so the prior list is the only record of which
// sources were actually in sync before.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, groupItem, livePasswordSyncGroup } from './fixtures'

registerCollectionDeployContract({
  label: 'password-sync-groups',
  handler: deploy,
  listPath: '/v3/password-sync-groups',
  createPath: '/v3/password-sync-groups',
  updatePath: '/v3/password-sync-groups/psg-2c10',
  updateMethod: 'PUT',
  item: groupItem(),
  live: livePasswordSyncGroup(),
  createBodyIncludes: ['Directory Sync Group', 'pp-standard', 'src-ldap'],
  updateBodyIncludes: ['pp-standard', 'src-ldap'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Sync Group', existed: false, id: 'psg-retired' },
    deletePath: '/v3/password-sync-groups/psg-retired',
  },
})
