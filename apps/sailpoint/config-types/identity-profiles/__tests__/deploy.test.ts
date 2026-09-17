// deploy for ISC identity profiles.
//
// An identity profile decides how identities are built from an authoritative
// source. Priority is the field that decides which profile wins a collision, so the
// prior priority is what rollback has to restore — not the one the canvas wanted.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveIdentityProfile, profileItem } from './fixtures'

registerCollectionDeployContract({
  label: 'identity-profiles',
  handler: deploy,
  listPath: '/v3/identity-profiles',
  createPath: '/v3/identity-profiles',
  updatePath: '/v3/identity-profiles/ip-44f0',
  updateMethod: 'PATCH',
  item: profileItem(),
  live: liveIdentityProfile(),
  createBodyIncludes: ['Workday Employees', 'src-workday', 'id-owner-current'],
  updateBodyIncludes: ['Employees sourced from Workday', 'id-owner-current'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Profile', existed: false, id: 'ip-retired' },
    deletePath: '/v3/identity-profiles/ip-retired',
  },
})
