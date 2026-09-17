// driftDetect for ISC certification campaign templates.
//
// The drift that matters is someone stretching the review deadline in the console.
// The campaign blob itself is normalised by ISC on save, so it is not tracked.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncCampaignTemplate, templateItem } from './fixtures'

registerCollectionDriftContract({
  label: 'campaign-templates',
  handler: driftDetect,
  listPath: '/v3/campaign-templates',
  item: templateItem(),
  matchingLive: inSyncCampaignTemplate(),
  driftedLive: inSyncCampaignTemplate({ deadlineDuration: 'P30D' }),
  driftedField: `${NAME}.deadlineDuration`,
  absentField: NAME,
})
