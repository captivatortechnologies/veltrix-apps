// rollback for ISC notification templates.
//
// Restoring means POSTing the prior override back — there is no other way to
// write a template. Overrides this deploy created are removed together through
// bulk-delete. An entry recorded as pre-existing with no snapshot has nothing to
// post back, and must not post the desired template a second time.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { BASE, BULK_DELETE, KEY, LOCALE, MEDIUM, PRIOR } from './fixtures'

const ADDRESS = { key: KEY, medium: MEDIUM, locale: LOCALE }

registerRollbackContract({
  label: 'notification-templates',
  handler: rollback,
  restore: {
    entry: { ...ADDRESS, existed: true, prior: PRIOR },
    method: 'POST',
    path: BASE,
    bodyIncludes: ['Legacy subject nobody updated', 'Legacy body nobody updated'],
  },
  remove: {
    entry: { ...ADDRESS, existed: false },
    method: 'POST',
    path: BULK_DELETE,
  },
  unrecoverable: [
    // Pre-existing, but deploy never captured what the override said.
    { ...ADDRESS, existed: true },
  ],
})
