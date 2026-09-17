// deploy for ISC sources.
//
// A source is where accounts come from. `connectorAttributes` carry the connector
// credentials and ISC masks them on read, so the patch writes them blind and the
// rollback entry can only promise the scalars — including `deleteThreshold`, the
// valve that stops a bad aggregation deleting every account.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveSource, sourceItem } from './fixtures'

registerCollectionDeployContract({
  label: 'sources',
  handler: deploy,
  listPath: '/v3/sources',
  createPath: '/v3/sources',
  updatePath: '/v3/sources/src-ad2200',
  updateMethod: 'PATCH',
  item: sourceItem(),
  live: liveSource(),
  createBodyIncludes: ['Active Directory', 'active-directory-direct', 'corp.example.test'],
  updateBodyIncludes: ['Corporate AD forest', 'corp.example.test', '"path":"/deleteThreshold","value":10'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Source', existed: false, id: 'src-retired' },
    deletePath: '/v3/sources/src-retired',
  },
})
