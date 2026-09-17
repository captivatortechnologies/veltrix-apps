// deploy for ISC managed clusters.
//
// A managed cluster is where on-prem connectors run. Deploy patches the name,
// description and configuration; the rollback snapshot deliberately carries only
// the scalars, so the test asserts what is actually recoverable rather than what
// one might hope was.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, clusterItem, liveManagedCluster } from './fixtures'

registerCollectionDeployContract({
  label: 'managed-clusters',
  handler: deploy,
  listPath: '/v3/managed-clusters',
  createPath: '/v3/managed-clusters',
  updatePath: '/v3/managed-clusters/mc-0b12',
  updateMethod: 'PATCH',
  item: clusterItem(),
  live: liveManagedCluster(),
  createBodyIncludes: ['On-Prem VA Cluster', 'sailpoint', 'VA cluster for the datacentre connectors'],
  updateBodyIncludes: ['VA cluster for the datacentre connectors'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Cluster', existed: false, id: 'mc-retired' },
    deletePath: '/v3/managed-clusters/mc-retired',
  },
})
