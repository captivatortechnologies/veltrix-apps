// deploy for ISC account correlation configurations.
//
// Correlation decides which account is attached to which identity. The update is a
// whole-body PUT of the attribute list, so the prior list recorded for rollback is
// the only way back to the mapping the tenant was actually running.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, configItem, liveCorrelationConfig } from './fixtures'

registerCollectionDeployContract({
  label: 'correlation-configs',
  handler: deploy,
  listPath: '/v3/correlation-config',
  createPath: '/v3/correlation-config',
  updatePath: '/v3/correlation-config/cc-55d0',
  updateMethod: 'PUT',
  item: configItem(),
  live: liveCorrelationConfig(),
  createBodyIncludes: ['HR Account Correlation', 'workEmail'],
  updateBodyIncludes: ['workEmail'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Correlation', existed: false, id: 'cc-retired' },
    deletePath: '/v3/correlation-config/cc-retired',
  },
})
