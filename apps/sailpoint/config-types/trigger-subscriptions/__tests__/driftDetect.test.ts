// driftDetect for ISC event trigger subscriptions.
//
// A subscription disabled or re-filtered in the console silently stops delivering
// events. The trigger id changing is critical: it is subscribed to something else.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncTriggerSubscription, subscriptionItem } from './fixtures'

registerCollectionDriftContract({
  label: 'trigger-subscriptions',
  handler: driftDetect,
  listPath: '/beta/trigger-subscriptions',
  item: subscriptionItem(),
  matchingLive: inSyncTriggerSubscription(),
  driftedLive: inSyncTriggerSubscription({ enabled: false }),
  driftedField: `${NAME}.enabled`,
  absentField: NAME,
})
