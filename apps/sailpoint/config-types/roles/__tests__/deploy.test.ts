// deploy for ISC roles.
//
// A role is the bundle of access profiles a person is granted. The patch replaces
// /accessProfiles wholesale, so the prior bundle recorded for rollback is the only
// record of what the role actually granted before.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveRole, roleItem } from './fixtures'

registerCollectionDeployContract({
  label: 'roles',
  handler: deploy,
  listPath: '/v3/roles',
  createPath: '/v3/roles',
  updatePath: '/v3/roles/role-2c9180',
  updateMethod: 'PATCH',
  item: roleItem(),
  live: liveRole(),
  createBodyIncludes: ['Finance Analyst', 'ap-finance-read', 'id-owner-current'],
  updateBodyIncludes: ['ap-reporting', 'id-owner-current'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Role', existed: false, id: 'role-retired' },
    deletePath: '/v3/roles/role-retired',
  },
})
