// driftDetect for ISC governance groups (workgroups).
//
// Someone re-pointing a governance group at a different owner in the console is the
// drift this exists to catch.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, groupItem, inSyncGovernanceGroup } from './fixtures'

registerCollectionDriftContract({
  label: 'governance-groups',
  handler: driftDetect,
  listPath: '/workgroups/v1',
  item: groupItem(),
  matchingLive: inSyncGovernanceGroup(),
  driftedLive: inSyncGovernanceGroup({ owner: { id: 'id-owner-someone-else' } }),
  driftedField: `${NAME}.owner`,
  absentField: NAME,
})
