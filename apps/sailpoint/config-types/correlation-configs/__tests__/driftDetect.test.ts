// driftDetect for ISC account correlation configurations.
//
// The attribute list is compared as a whole, key order ignored, so re-serialisation
// by ISC does not read as drift — a changed correlation attribute does.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, configItem, inSyncCorrelationConfig } from './fixtures'

registerCollectionDriftContract({
  label: 'correlation-configs',
  handler: driftDetect,
  listPath: '/v3/correlation-config',
  item: configItem(),
  matchingLive: inSyncCorrelationConfig(),
  driftedLive: inSyncCorrelationConfig({ attributes: [{ property: 'email', value: 'personalEmail' }] }),
  driftedField: `${NAME}.attributes`,
  absentField: NAME,
})
