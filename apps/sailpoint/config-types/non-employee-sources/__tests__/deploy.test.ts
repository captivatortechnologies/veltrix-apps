// deploy for ISC non-employee sources.
//
// A non-employee source is where contractor records live and who administers them.
// The patch replaces the approver and account-manager lists wholesale, so the prior
// management workgroup is what rollback has to restore.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveNonEmployeeSource, sourceItem } from './fixtures'

registerCollectionDeployContract({
  label: 'non-employee-sources',
  handler: deploy,
  listPath: '/beta/non-employee-sources',
  createPath: '/beta/non-employee-sources',
  updatePath: '/beta/non-employee-sources/nes-31aa',
  updateMethod: 'PATCH',
  item: sourceItem(),
  live: liveNonEmployeeSource(),
  createBodyIncludes: ['Contractors', 'wg-vendor-team', 'id-approver-1'],
  updateBodyIncludes: ['wg-vendor-team', 'id-approver-1'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Source', existed: false, id: 'nes-retired' },
    deletePath: '/beta/non-employee-sources/nes-retired',
  },
})
