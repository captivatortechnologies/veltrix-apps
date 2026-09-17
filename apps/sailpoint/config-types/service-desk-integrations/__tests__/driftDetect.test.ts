// driftDetect for ISC service desk integrations.
//
// Secret attributes are masked on GET, so drift tracks the scalars. A retyped
// integration is critical — tickets would start going somewhere else.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncServiceDesk, integrationItem } from './fixtures'

registerCollectionDriftContract({
  label: 'service-desk-integrations',
  handler: driftDetect,
  listPath: '/v3/service-desk-integrations',
  item: integrationItem(),
  matchingLive: inSyncServiceDesk(),
  driftedLive: inSyncServiceDesk({ type: 'GenericSDIM' }),
  driftedField: `${NAME}.type`,
  absentField: NAME,
})
