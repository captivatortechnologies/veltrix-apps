// driftDetect for ISC role dimensions.
//
// Drift here has two shapes worth separating: the dimension changed inside its
// role, and the role itself is gone. Both are critical, but only one of them
// means someone deleted a dimension.

import { registerNestedDriftContract } from '../../../lib/__tests__/nestedContracts'
import driftDetect from '../driftDetect'
import { CHILD_PATH, LABEL, dimensionItem, inSyncDimension, parentRole } from './fixtures'

registerNestedDriftContract({
  label: 'dimensions',
  handler: driftDetect,
  parentListPath: '/v3/roles',
  parent: parentRole(),
  childPath: CHILD_PATH,
  item: dimensionItem(),
  matchingLive: inSyncDimension(),
  driftedLive: inSyncDimension({ owner: { id: 'id-owner-someone-else', type: 'IDENTITY' } }),
  driftedField: `${LABEL}.owner`,
  absentField: LABEL,
  parentAbsentActual: 'role absent',
})
