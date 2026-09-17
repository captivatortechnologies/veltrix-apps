// rollback for ISC segments.
//
// Restoring a segment puts back its prior name, description and active flag.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'segments',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/segments/v1/seg-9a0155',
    bodyIncludes: ['Legacy description nobody updated', '"path":"/active","value":false'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'segment-created' },
    method: 'DELETE',
    path: '/segments/v1/segment-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
