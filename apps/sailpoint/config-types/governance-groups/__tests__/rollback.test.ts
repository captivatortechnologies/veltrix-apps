// rollback for ISC governance groups (workgroups).
//
// Restoring a governance group puts back its prior name, description and owner —
// the owner above all, because that is who approvals route to.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'governance-groups',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/workgroups/v1/wg-88c1',
    bodyIncludes: ['Legacy description nobody updated', 'id-owner-departed'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'group-created' },
    method: 'DELETE',
    path: '/workgroups/v1/group-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
