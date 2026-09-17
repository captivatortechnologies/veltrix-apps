// rollback for ISC roles.
//
// Restoring a role puts back the prior access-profile bundle, owner and enabled
// flag — the bundle above all, because that is what people actually have.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'roles',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/v3/roles/role-2c9180',
    bodyIncludes: ['Legacy description nobody updated', 'ap-finance-legacy', 'id-owner-departed'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'role-created' },
    method: 'DELETE',
    path: '/v3/roles/role-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
