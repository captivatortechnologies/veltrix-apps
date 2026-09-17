// rollback for ISC service desk integrations.
//
// Restoring a service desk integration puts back the name and description. The
// secret attributes were never readable, so they are not (and must not be)
// fabricated.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'service-desk-integrations',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/v3/service-desk-integrations/sdi-4b20f1',
    bodyIncludes: ['Legacy description nobody updated'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'integration-created' },
    method: 'DELETE',
    path: '/v3/service-desk-integrations/integration-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
