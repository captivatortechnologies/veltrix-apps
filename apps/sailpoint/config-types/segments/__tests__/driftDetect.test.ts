// driftDetect for ISC segments.
//
// A segment deactivated in the console silently widens what everyone can see —
// that is the drift worth catching.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncSegment, segmentItem } from './fixtures'

registerCollectionDriftContract({
  label: 'segments',
  handler: driftDetect,
  listPath: '/segments/v1',
  item: segmentItem(),
  matchingLive: inSyncSegment(),
  driftedLive: inSyncSegment({ active: false }),
  driftedField: `${NAME}.active`,
  absentField: NAME,
})
