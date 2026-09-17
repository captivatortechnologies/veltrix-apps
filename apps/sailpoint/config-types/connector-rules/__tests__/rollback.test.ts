// rollback for ISC connector rules.
//
// Restoring a connector rule PUTs back the exact prior body, script included. A
// rule this deploy created is deleted; one with no captured body is left alone.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'connector-rules',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PUT',
    path: '/beta/connector-rules/cr-19ab55',
    bodyIncludes: ['Legacy description nobody updated', 'superseded'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'rule-created' },
    method: 'DELETE',
    path: '/beta/connector-rules/rule-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
