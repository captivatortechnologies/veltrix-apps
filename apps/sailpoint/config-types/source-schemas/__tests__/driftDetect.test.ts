// driftDetect for ISC source schemas.
//
// The identity and display attributes are only compared when the canvas declares
// them, so a schema that leaves them to the connector is not nagged about it. A
// changed identity attribute is the one that matters: it decides which account
// lands on which identity.

import { registerNestedDriftContract } from '../../../lib/__tests__/nestedContracts'
import driftDetect from '../driftDetect'
import { CHILD_PATH, LABEL, inSyncSchema, parentSource, schemaItem } from './fixtures'

registerNestedDriftContract({
  label: 'source-schemas',
  handler: driftDetect,
  parentListPath: '/v3/sources',
  parent: parentSource(),
  childPath: CHILD_PATH,
  item: schemaItem(),
  matchingLive: inSyncSchema(),
  driftedLive: inSyncSchema({ identityAttribute: 'userPrincipalName' }),
  driftedField: `${LABEL}.identityAttribute`,
  absentField: LABEL,
  parentAbsentActual: 'source absent',
})
