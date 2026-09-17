// rollback for ISC source apps.
//
// Restoring a source app puts back the name, description and matchAllAccounts flag
// it had.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'source-apps',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/beta/source-apps/sa-77aa31',
    bodyIncludes: ['Legacy description nobody updated', '"path":"/matchAllAccounts","value":false'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'app-created' },
    method: 'DELETE',
    path: '/beta/source-apps/app-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
