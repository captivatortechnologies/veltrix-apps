// rollback for ISC separation-of-duties policies.
//
// Restoring an SOD policy puts back its prior state, type and owner. The state is
// the one that matters: it decides whether violations are detected at all.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'sod-policies',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/v3/sod-policies/sod-1188c0',
    bodyIncludes: ['NOT_ENFORCED', 'id-owner-departed'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'policy-created' },
    method: 'DELETE',
    path: '/v3/sod-policies/policy-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
