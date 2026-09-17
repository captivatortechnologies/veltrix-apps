// driftDetect for ISC source apps.
//
// A re-pointed account source is critical: the app would start surfacing a
// different population of accounts entirely.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, appItem, inSyncSourceApp } from './fixtures'

registerCollectionDriftContract({
  label: 'source-apps',
  handler: driftDetect,
  listPath: '/beta/source-apps/all',
  item: appItem(),
  matchingLive: inSyncSourceApp(),
  driftedLive: inSyncSourceApp({ accountSource: { id: 'src-somewhere-else' } }),
  driftedField: `${NAME}.accountSource`,
  absentField: NAME,
})
