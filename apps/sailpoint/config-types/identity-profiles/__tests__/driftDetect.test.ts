// driftDetect for ISC identity profiles.
//
// A changed authoritative source is critical — every identity the profile builds
// comes from somewhere else after that. A changed priority is a reordering.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncIdentityProfile, profileItem } from './fixtures'

registerCollectionDriftContract({
  label: 'identity-profiles',
  handler: driftDetect,
  listPath: '/v3/identity-profiles',
  item: profileItem(),
  matchingLive: inSyncIdentityProfile(),
  driftedLive: inSyncIdentityProfile({ authoritativeSource: { id: 'src-somewhere-else' } }),
  driftedField: `${NAME}.authoritativeSource`,
  absentField: NAME,
})
