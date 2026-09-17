// driftDetect for ISC sources.
//
// The delete threshold is only compared when the canvas declares one, so a source
// that leaves it unset is not nagged about it. Connector attributes are masked on
// GET and are not tracked.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncSource, sourceItem } from './fixtures'

registerCollectionDriftContract({
  label: 'sources',
  handler: driftDetect,
  listPath: '/v3/sources',
  item: sourceItem(),
  matchingLive: inSyncSource(),
  driftedLive: inSyncSource({ deleteThreshold: 90 }),
  driftedField: `${NAME}.deleteThreshold`,
  absentField: NAME,
})
