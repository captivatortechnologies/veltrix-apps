// deploy for ISC SIM (service integration module) integrations.
//
// The managed `sources` list decides which resources route through this
// integration; the patch replaces it wholesale, so the prior list is the only
// record of what was covered before.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, integrationItem, liveSimIntegration } from './fixtures'

registerCollectionDeployContract({
  label: 'sim-integrations',
  handler: deploy,
  listPath: '/beta/sim-integrations',
  createPath: '/beta/sim-integrations',
  updatePath: '/beta/sim-integrations/sim-6d3390',
  updateMethod: 'PATCH',
  item: integrationItem(),
  live: liveSimIntegration(),
  createBodyIncludes: ['ServiceNow SIM', 'src-ldap', 'acme.service-now.example'],
  updateBodyIncludes: ['src-ldap', 'acme.service-now.example'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired SIM', existed: false, id: 'sim-retired' },
    deletePath: '/beta/sim-integrations/sim-retired',
  },
})
