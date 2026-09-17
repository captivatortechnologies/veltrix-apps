// driftDetect for ISC lifecycle states.
//
// A lifecycle state switched off in the console stops running its account actions
// while still looking present, which is the case drift detection exists for. The
// state is matched by `technicalName`, so a renamed display name is not drift.

import { registerNestedDriftContract } from '../../../lib/__tests__/nestedContracts'
import driftDetect from '../driftDetect'
import { CHILD_PATH, LABEL, inSyncState, parentProfile, stateItem } from './fixtures'

registerNestedDriftContract({
  label: 'lifecycle-states',
  handler: driftDetect,
  parentListPath: '/v3/identity-profiles',
  parent: parentProfile(),
  childPath: CHILD_PATH,
  item: stateItem(),
  matchingLive: inSyncState(),
  driftedLive: inSyncState({ enabled: false }),
  driftedField: `${LABEL}.enabled`,
  absentField: LABEL,
  parentAbsentActual: 'profile absent',
})
