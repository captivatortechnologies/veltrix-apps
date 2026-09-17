// rollback for ISC password sync groups.
//
// Restoring a sync group PUTs back the prior policy and source list.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'password-sync-groups',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PUT',
    path: '/v3/password-sync-groups/psg-2c10',
    bodyIncludes: ['pp-legacy'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'group-created' },
    method: 'DELETE',
    path: '/v3/password-sync-groups/group-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
