// deploy for ISC source apps.
//
// `matchAllAccounts` decides whether everyone with an account on the source sees
// the app in the request centre, so the prior value is what rollback restores. The
// account source is immutable and is never patched.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, appItem, liveSourceApp } from './fixtures'

registerCollectionDeployContract({
  label: 'source-apps',
  handler: deploy,
  listPath: '/beta/source-apps/all',
  createPath: '/beta/source-apps',
  updatePath: '/beta/source-apps/sa-77aa31',
  updateMethod: 'PATCH',
  item: appItem(),
  live: liveSourceApp(),
  createBodyIncludes: ['Salesforce App', 'src-salesforce', '"matchAllAccounts":true'],
  updateBodyIncludes: ['Salesforce accounts in the request centre', '"path":"/matchAllAccounts","value":true'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired App', existed: false, id: 'sa-retired' },
    deletePath: '/beta/source-apps/sa-retired',
  },
})
