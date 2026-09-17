// rollback for ISC non-employee sources.
//
// Restoring a non-employee source puts back its name, description and management
// workgroup.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'non-employee-sources',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/beta/non-employee-sources/nes-31aa',
    bodyIncludes: ['Legacy description nobody updated', 'wg-legacy-admins'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'source-created' },
    method: 'DELETE',
    path: '/beta/non-employee-sources/source-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
