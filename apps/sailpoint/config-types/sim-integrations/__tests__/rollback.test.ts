// rollback for ISC SIM (service integration module) integrations.
//
// Restoring a SIM integration puts back its name, description and managed-resource
// list. The secret attributes were never readable and are not invented.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'sim-integrations',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/beta/sim-integrations/sim-6d3390',
    bodyIncludes: ['Legacy description nobody updated', 'src-legacy'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'integration-created' },
    method: 'DELETE',
    path: '/beta/sim-integrations/integration-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
