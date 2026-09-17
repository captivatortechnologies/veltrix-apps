// driftDetect for ISC password policies.
//
// Every managed rule field is compared, so a minimum length quietly lowered in the
// console is reported field by field.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncPasswordPolicy, policyItem } from './fixtures'

registerCollectionDriftContract({
  label: 'password-policies',
  handler: driftDetect,
  listPath: '/v3/password-policies',
  item: policyItem(),
  matchingLive: inSyncPasswordPolicy(),
  driftedLive: inSyncPasswordPolicy({ minLength: 6 }),
  driftedField: `${NAME}.minLength`,
  absentField: NAME,
})
