// deploy for ISC governance groups (workgroups).
//
// A governance group is the set of people who approve access requests, so the owner
// is the field that matters: patching it moves approval authority.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, groupItem, liveGovernanceGroup } from './fixtures'

registerCollectionDeployContract({
  label: 'governance-groups',
  handler: deploy,
  listPath: '/workgroups/v1',
  createPath: '/workgroups/v1',
  updatePath: '/workgroups/v1/wg-88c1',
  updateMethod: 'PATCH',
  item: groupItem(),
  live: liveGovernanceGroup(),
  createBodyIncludes: ['Finance Governance Board', 'id-owner-current'],
  updateBodyIncludes: ['Owns finance access decisions', 'id-owner-current'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Board', existed: false, id: 'wg-retired' },
    deletePath: '/workgroups/v1/wg-retired',
  },
})
