// rollback for ISC lifecycle states.
//
// Restoring a lifecycle state puts back the account actions the tenant had. An
// entry with no state id, or one recorded as pre-existing with nothing captured,
// must make no call: writing an invented action list would disable or re-enable
// real accounts.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { CHILD_PATH, PRIOR, PROFILE_ID, PROFILE_NAME, STATE_ID, TECHNICAL_NAME } from './fixtures'

const BASE_ENTRY = { profileName: PROFILE_NAME, profileId: PROFILE_ID, technicalName: TECHNICAL_NAME }

registerRollbackContract({
  label: 'lifecycle-states',
  handler: rollback,
  restore: {
    entry: { ...BASE_ENTRY, existed: true, stateId: STATE_ID, prior: PRIOR },
    method: 'PATCH',
    path: `${CHILD_PATH}/${STATE_ID}`,
    bodyIncludes: ['Legacy description nobody updated', 'ap-legacy-offboard', 'src-legacy'],
  },
  remove: {
    entry: { ...BASE_ENTRY, existed: false, stateId: 'ls-created' },
    method: 'DELETE',
    path: `${CHILD_PATH}/ls-created`,
  },
  unrecoverable: [
    // Created, but the vendor response carried no id — nothing to delete.
    { ...BASE_ENTRY, existed: false },
    // Pre-existing, but deploy never captured the account actions it had.
    { ...BASE_ENTRY, existed: true, stateId: STATE_ID },
  ],
})
