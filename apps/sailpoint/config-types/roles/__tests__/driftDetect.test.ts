// driftDetect for ISC roles.
//
// The access-profile bundle is compared as a set. Someone adding a profile to a
// role in the console grants it to everyone who holds the role.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncRole, roleItem } from './fixtures'

registerCollectionDriftContract({
  label: 'roles',
  handler: driftDetect,
  listPath: '/v3/roles',
  item: roleItem(),
  matchingLive: inSyncRole(),
  driftedLive: inSyncRole({ accessProfiles: [{ id: 'ap-reporting' }, { id: 'ap-finance-read' }, { id: 'ap-payroll' }] }),
  driftedField: `${NAME}.accessProfiles`,
  absentField: NAME,
})
