// deploy for ISC service desk integrations.
//
// This is the integration that raises provisioning tickets. Its `attributes` carry
// the provider credentials and are never read back, so the update patches them
// blind and the rollback entry can only promise the scalars.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, integrationItem, liveServiceDesk } from './fixtures'

registerCollectionDeployContract({
  label: 'service-desk-integrations',
  handler: deploy,
  listPath: '/v3/service-desk-integrations',
  createPath: '/v3/service-desk-integrations',
  updatePath: '/v3/service-desk-integrations/sdi-4b20f1',
  updateMethod: 'PATCH',
  item: integrationItem(),
  live: liveServiceDesk(),
  createBodyIncludes: ['ServiceNow Tickets', 'ServiceNowSDIM', 'acme.service-now.example'],
  updateBodyIncludes: ['Raise provisioning tickets in ServiceNow', 'acme.service-now.example'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Integration', existed: false, id: 'sdi-retired' },
    deletePath: '/v3/service-desk-integrations/sdi-retired',
  },
})
