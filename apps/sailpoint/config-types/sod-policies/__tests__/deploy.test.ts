// deploy for ISC separation-of-duties policies.
//
// A separation-of-duties policy is only worth anything in the ENFORCED state. The
// update is a whole-body PUT, so the prior state is what rollback has to restore —
// restoring the desired state instead would leave a policy enforced that the tenant
// had deliberately parked.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveSodPolicy, policyItem } from './fixtures'

registerCollectionDeployContract({
  label: 'sod-policies',
  handler: deploy,
  listPath: '/v3/sod-policies',
  createPath: '/v3/sod-policies',
  updatePath: '/v3/sod-policies/sod-1188c0',
  updateMethod: 'PUT',
  item: policyItem(),
  live: liveSodPolicy(),
  createBodyIncludes: ['AP vs AR Separation', 'ENFORCED', 'id-owner-current'],
  updateBodyIncludes: ['ENFORCED', 'attribute.department:Finance'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Policy', existed: false, id: 'sod-retired' },
    deletePath: '/v3/sod-policies/sod-retired',
  },
})
