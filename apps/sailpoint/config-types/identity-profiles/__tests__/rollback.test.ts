// rollback for ISC identity profiles.
//
// Restoring an identity profile puts back its name, description, owner and
// priority. The authoritative source is immutable and is never patched.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'identity-profiles',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/v3/identity-profiles/ip-44f0',
    bodyIncludes: ['Legacy description nobody updated', 'id-owner-departed'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'profile-created' },
    method: 'DELETE',
    path: '/v3/identity-profiles/profile-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
