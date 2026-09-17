// driftDetect for ISC SIM (service integration module) integrations.
//
// Resources are compared as a set, so the order ISC returns them in is not drift;
// a resource added or dropped in the console is.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncSimIntegration, integrationItem } from './fixtures'

registerCollectionDriftContract({
  label: 'sim-integrations',
  handler: driftDetect,
  listPath: '/beta/sim-integrations',
  item: integrationItem(),
  matchingLive: inSyncSimIntegration(),
  driftedLive: inSyncSimIntegration({ sources: ['src-ad'] }),
  driftedField: `${NAME}.sources`,
  absentField: NAME,
})
