// rollback for ISC event trigger subscriptions.
//
// Restoring a subscription puts back its enabled flag and filter — the two fields
// that decide whether events are delivered and which ones.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { LIVE_ID, NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'trigger-subscriptions',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, id: LIVE_ID, prior: PRIOR },
    method: 'PATCH',
    path: '/beta/trigger-subscriptions/ts-3c44ef',
    bodyIncludes: ['Legacy description nobody updated', '$.legacyFilter'],
  },
  remove: {
    entry: { name: NAME, existed: false, id: 'subscription-created' },
    method: 'DELETE',
    path: '/beta/trigger-subscriptions/subscription-created',
  },
  unrecoverable: [{ name: NAME, existed: false }, { name: NAME, existed: true, id: LIVE_ID }],
})
