// rollback for ISC extended search attributes.
//
// Restoring puts back the prior display name and source map. An entry recorded as
// pre-existing with no snapshot has nothing to restore and must make no call.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'search-attribute-config',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, prior: PRIOR },
    method: 'PATCH',
    path: '/v3/accounts/search-attribute-config/newMailAttribute',
    bodyIncludes: ['Alternate Mail (legacy)', 'src-legacy'],
  },
  remove: {
    entry: { name: NAME, existed: false },
    method: 'DELETE',
    path: '/v3/accounts/search-attribute-config/newMailAttribute',
  },
  unrecoverable: [{ name: NAME, existed: true }],
})
