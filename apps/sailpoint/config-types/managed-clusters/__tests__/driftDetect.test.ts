// driftDetect for ISC managed clusters.
//
// A cluster retyped in the console is drift; the configuration blob is not tracked.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, clusterItem, inSyncManagedCluster } from './fixtures'

registerCollectionDriftContract({
  label: 'managed-clusters',
  handler: driftDetect,
  listPath: '/v3/managed-clusters',
  item: clusterItem(),
  matchingLive: inSyncManagedCluster(),
  driftedLive: inSyncManagedCluster({ type: 'idn' }),
  driftedField: `${NAME}.type`,
  absentField: NAME,
})
