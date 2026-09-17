// driftDetect for ISC extended search attributes.
//
// The source map is compared as a whole with a stable stringify, so key order is
// not drift; a source repointed at a different account attribute is.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, attributeItem, inSyncSearchAttribute } from './fixtures'

registerCollectionDriftContract({
  label: 'search-attribute-config',
  handler: driftDetect,
  listPath: '/v3/accounts/search-attribute-config',
  item: attributeItem(),
  matchingLive: inSyncSearchAttribute(),
  driftedLive: inSyncSearchAttribute({ applicationAttributes: { 'src-ad': 'proxyAddresses' } }),
  driftedField: `${NAME}.applicationAttributes`,
  absentField: NAME,
})
