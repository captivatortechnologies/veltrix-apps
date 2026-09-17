// driftDetect for ISC separation-of-duties policies.
//
// A policy moved out of ENFORCED in the console stops detecting conflicts while
// still looking present — that is exactly what drift has to surface.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncSodPolicy, policyItem } from './fixtures'

registerCollectionDriftContract({
  label: 'sod-policies',
  handler: driftDetect,
  listPath: '/v3/sod-policies',
  item: policyItem(),
  matchingLive: inSyncSodPolicy(),
  driftedLive: inSyncSodPolicy({ state: 'NOT_ENFORCED' }),
  driftedField: `${NAME}.state`,
  absentField: NAME,
})
