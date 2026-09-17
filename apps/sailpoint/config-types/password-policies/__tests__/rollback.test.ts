// rollback for ISC password policies.
//
// Restoring a password policy PUTs the prior body back, read-only timestamps
// already stripped by deploy.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'password-policies',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PUT',
    path: '/v3/password-policies/pp-77e2',
    bodyIncludes: ['"minLength":8', 'Legacy description nobody updated'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'policy-created' },
    method: 'DELETE',
    path: '/v3/password-policies/policy-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
