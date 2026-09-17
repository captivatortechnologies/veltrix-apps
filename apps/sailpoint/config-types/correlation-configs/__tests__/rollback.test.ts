// rollback for ISC account correlation configurations.
//
// Restoring a correlation config PUTs back the prior attribute list verbatim.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'correlation-configs',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PUT',
    path: '/v3/correlation-config/cc-55d0',
    bodyIncludes: ['legacyEmployeeId'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'config-created' },
    method: 'DELETE',
    path: '/v3/correlation-config/config-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
