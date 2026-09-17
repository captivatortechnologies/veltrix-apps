// deploy for ISC certification campaign templates.
//
// A campaign template is what generates certification campaigns, so the update path
// replaces the whole campaign definition through JSON-Patch. The prior recorded for
// rollback has to be the deadline the tenant had, not the one the canvas asked for.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveCampaignTemplate, templateItem } from './fixtures'

registerCollectionDeployContract({
  label: 'campaign-templates',
  handler: deploy,
  listPath: '/v3/campaign-templates',
  createPath: '/v3/campaign-templates',
  updatePath: '/v3/campaign-templates/ct-7f21a3',
  updateMethod: 'PATCH',
  item: templateItem(),
  live: liveCampaignTemplate(),
  createBodyIncludes: ['Quarterly Finance Access Review', 'Quarterly review of all finance access', 'P2W'],
  updateBodyIncludes: ['Quarterly review of all finance access', 'P2W'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Review', existed: false, id: 'ct-retired' },
    deletePath: '/v3/campaign-templates/ct-retired',
  },
})
