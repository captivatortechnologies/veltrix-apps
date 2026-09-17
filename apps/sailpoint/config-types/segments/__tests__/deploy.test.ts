// deploy for ISC segments.
//
// A segment decides which identities can even see an item of access. Flipping
// `active` changes what a population can request, so the prior value is what
// rollback has to put back.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveSegment, segmentItem } from './fixtures'

registerCollectionDeployContract({
  label: 'segments',
  handler: deploy,
  listPath: '/segments/v1',
  createPath: '/segments/v1',
  updatePath: '/segments/v1/seg-9a0155',
  updateMethod: 'PATCH',
  item: segmentItem(),
  live: liveSegment(),
  createBodyIncludes: ['EMEA Segment', 'Access visible to EMEA staff', '"active":true'],
  updateBodyIncludes: ['Access visible to EMEA staff', '"path":"/active","value":true'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Segment', existed: false, id: 'seg-retired' },
    deletePath: '/segments/v1/seg-retired',
  },
})
