// deploy for ISC extended search attributes.
//
// An extended search attribute is what analysts search and report on. The patch
// replaces the whole sourceId-to-attribute map, so the prior map is the only record
// of what was actually being indexed.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { NAME, PRIOR, attributeItem, liveSearchAttribute } from './fixtures'

registerCollectionDeployContract({
  label: 'search-attribute-config',
  handler: deploy,
  listPath: '/v3/accounts/search-attribute-config',
  createPath: '/v3/accounts/search-attribute-config',
  updatePath: '/v3/accounts/search-attribute-config/newMailAttribute',
  updateMethod: 'PATCH',
  item: attributeItem(),
  live: liveSearchAttribute(),
  createBodyIncludes: ['newMailAttribute', 'Alternate Mail', 'src-ad'],
  updateBodyIncludes: ['Alternate Mail', 'src-ad'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.name, NAME)
  },
  assertPrior: (entry) => {
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'retiredAttribute', existed: false },
    deletePath: '/v3/accounts/search-attribute-config/retiredAttribute',
  },
})
