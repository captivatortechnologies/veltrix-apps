// driftDetect for ISC identity attributes.
//
// `searchable` is the one that costs: an attribute quietly made unsearchable breaks
// every saved search and report built on it.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, attributeItem, inSyncIdentityAttribute } from './fixtures'

registerCollectionDriftContract({
  label: 'identity-attributes',
  handler: driftDetect,
  listPath: '/beta/identity-attributes',
  item: attributeItem(),
  matchingLive: inSyncIdentityAttribute(),
  driftedLive: inSyncIdentityAttribute({ searchable: false }),
  driftedField: `${NAME}.searchable`,
  absentField: NAME,
})
