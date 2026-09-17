// rollback for ISC transforms.
//
// Restoring a transform PUTs back its prior body — name, type and the whole
// attributes graph.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'transforms',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PUT',
    path: '/transforms/v1/tf-5f9022',
    bodyIncludes: ['identityAttribute', 'legacyEmail'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'transform-created' },
    method: 'DELETE',
    path: '/transforms/v1/transform-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
