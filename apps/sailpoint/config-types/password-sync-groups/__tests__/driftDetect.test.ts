// driftDetect for ISC password sync groups.
//
// Source membership is compared as a set, so the order ISC returns it in does not
// read as drift — a source added or removed in the console does.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, groupItem, inSyncPasswordSyncGroup } from './fixtures'

registerCollectionDriftContract({
  label: 'password-sync-groups',
  handler: driftDetect,
  listPath: '/v3/password-sync-groups',
  item: groupItem(),
  matchingLive: inSyncPasswordSyncGroup(),
  driftedLive: inSyncPasswordSyncGroup({ sourceIds: ['src-ad'] }),
  driftedField: `${NAME}.sourceIds`,
  absentField: NAME,
})
