// rollback for ISC provisioning policies.
//
// Restoring a provisioning policy PUTs back the prior attribute map. An entry
// recorded as pre-existing with nothing captured must make no call: a PUT built
// from the desired state would leave the wrong attributes being written into the
// directory on every account create.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { CHILD_PATH, PRIOR, SOURCE_ID, SOURCE_NAME, USAGE_TYPE } from './fixtures'

const BASE_ENTRY = { sourceName: SOURCE_NAME, sourceId: SOURCE_ID }

registerRollbackContract({
  label: 'provisioning-policies',
  handler: rollback,
  restore: {
    entry: { ...BASE_ENTRY, usageType: USAGE_TYPE, existed: true, prior: PRIOR },
    method: 'PUT',
    path: `${CHILD_PATH}/${USAGE_TYPE}`,
    bodyIncludes: ['Legacy Create Policy', 'Legacy description nobody updated', '"cn"'],
  },
  remove: {
    entry: { ...BASE_ENTRY, usageType: 'UPDATE', existed: false },
    method: 'DELETE',
    path: `${CHILD_PATH}/UPDATE`,
  },
  unrecoverable: [
    // Pre-existing, but deploy never captured the attribute map it had.
    { ...BASE_ENTRY, usageType: USAGE_TYPE, existed: true },
  ],
})
