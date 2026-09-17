// driftDetect for ISC non-employee sources.
//
// Someone moving the management workgroup in the console changes who can add
// contractors — that is the drift worth reporting.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncNonEmployeeSource, sourceItem } from './fixtures'

registerCollectionDriftContract({
  label: 'non-employee-sources',
  handler: driftDetect,
  listPath: '/beta/non-employee-sources',
  item: sourceItem(),
  matchingLive: inSyncNonEmployeeSource(),
  driftedLive: inSyncNonEmployeeSource({ managementWorkgroup: 'wg-taken-over' }),
  driftedField: `${NAME}.managementWorkgroup`,
  absentField: NAME,
})
