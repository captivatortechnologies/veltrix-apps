// rollback for ISC managed clusters.
//
// Restoring a managed cluster puts back the name and description it had. A cluster
// this deploy created is deleted.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'managed-clusters',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/v3/managed-clusters/mc-0b12',
    bodyIncludes: ['Legacy description nobody updated'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'cluster-created' },
    method: 'DELETE',
    path: '/v3/managed-clusters/cluster-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
