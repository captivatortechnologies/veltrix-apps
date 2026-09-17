// rollback for ISC sources.
//
// Restoring a source puts back its name, description, owner and delete threshold.
// The connector attributes were never readable and are not invented.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'sources',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/v3/sources/src-ad2200',
    bodyIncludes: ['Legacy description nobody updated', 'id-owner-departed'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'source-created' },
    method: 'DELETE',
    path: '/v3/sources/source-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
