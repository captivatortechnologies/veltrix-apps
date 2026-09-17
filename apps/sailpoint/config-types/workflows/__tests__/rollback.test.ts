// rollback for ISC workflows.
//
// Restoring a workflow PUTs back the prior body: its trigger, its definition and
// whether it was running.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'workflows',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PUT',
    path: '/v3/workflows/wf-77b3aa',
    bodyIncludes: ['Legacy description nobody updated', 'idn:identity-attributes-changed', 'legacyStep'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'workflow-created' },
    method: 'DELETE',
    path: '/v3/workflows/workflow-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
