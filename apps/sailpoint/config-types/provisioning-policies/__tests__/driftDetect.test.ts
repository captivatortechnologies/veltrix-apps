// driftDetect for ISC provisioning policies.
//
// Policies are matched by usage type within their source, so the drift reported
// is "the CREATE policy on this source changed", never "a policy went missing"
// when it is really the source that is gone.

import { registerNestedDriftContract } from '../../../lib/__tests__/nestedContracts'
import driftDetect from '../driftDetect'
import { CHILD_PATH, LABEL, inSyncPolicy, parentSource, policyItem } from './fixtures'

registerNestedDriftContract({
  label: 'provisioning-policies',
  handler: driftDetect,
  parentListPath: '/v3/sources',
  parent: parentSource(),
  childPath: CHILD_PATH,
  item: policyItem(),
  matchingLive: inSyncPolicy(),
  driftedLive: inSyncPolicy({ name: 'Renamed in the console' }),
  driftedField: `${LABEL}.name`,
  absentField: LABEL,
  parentAbsentActual: 'source absent',
})
