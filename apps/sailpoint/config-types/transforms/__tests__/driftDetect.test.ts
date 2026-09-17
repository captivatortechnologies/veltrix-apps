// driftDetect for ISC transforms.
//
// Attributes are compared with a stable stringify so ISC re-serialising them is not
// drift; a changed input attribute is.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncTransform, transformItem } from './fixtures'

registerCollectionDriftContract({
  label: 'transforms',
  handler: driftDetect,
  listPath: '/transforms/v1',
  item: transformItem(),
  matchingLive: inSyncTransform(),
  driftedLive: inSyncTransform({
    attributes: {
      input: {
        type: 'accountAttribute',
        attributes: { sourceName: 'AD', attributeName: 'userPrincipalName' },
      },
    },
  }),
  driftedField: `${NAME}.attributes`,
  absentField: NAME,
})
