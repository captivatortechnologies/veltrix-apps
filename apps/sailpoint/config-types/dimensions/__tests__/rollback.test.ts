// rollback for ISC role dimensions.
//
// A dimension's rollback entry has to carry the parent role id as well as the
// dimension id — without the role there is no path to write to. An entry missing
// either must make no call: a dimension is a live grant of access, and writing an
// invented bundle over one changes what a population actually holds.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { CHILD_PATH, DIMENSION_ID, NAME, PRIOR, ROLE_ID, ROLE_NAME } from './fixtures'

registerRollbackContract({
  label: 'dimensions',
  handler: rollback,
  restore: {
    entry: { roleName: ROLE_NAME, roleId: ROLE_ID, name: NAME, existed: true, dimensionId: DIMENSION_ID, prior: PRIOR },
    method: 'PATCH',
    path: `${CHILD_PATH}/${DIMENSION_ID}`,
    bodyIncludes: ['Legacy description nobody updated', 'id-owner-departed', 'ap-legacy-finance', 'ent-legacy-ledger'],
  },
  remove: {
    entry: { roleName: ROLE_NAME, roleId: ROLE_ID, name: NAME, existed: false, dimensionId: 'dim-created' },
    method: 'DELETE',
    path: `${CHILD_PATH}/dim-created`,
  },
  unrecoverable: [
    // Created, but the vendor response carried no id — nothing to delete.
    { roleName: ROLE_NAME, roleId: ROLE_ID, name: NAME, existed: false },
    // Pre-existing, but deploy never captured the bundle it had.
    { roleName: ROLE_NAME, roleId: ROLE_ID, name: NAME, existed: true, dimensionId: DIMENSION_ID },
  ],
})
