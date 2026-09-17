// rollback for ISC certification campaign templates.
//
// Restoring a template means putting back the name, description and deadline the
// tenant had; a template this deploy created is removed outright.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'campaign-templates',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/v3/campaign-templates/ct-7f21a3',
    bodyIncludes: ['Legacy description nobody updated', 'P1W'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'template-created' },
    method: 'DELETE',
    path: '/v3/campaign-templates/template-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
