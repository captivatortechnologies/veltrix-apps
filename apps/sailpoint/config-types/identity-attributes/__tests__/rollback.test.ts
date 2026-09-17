// rollback for ISC identity attributes.
//
// There is no id to fall back on here: everything is keyed by the technical name.
// An entry deploy recorded as pre-existing but never snapshotted has nothing to put
// back, so it must make no call rather than PUT an invented definition over a live
// attribute.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { NAME, PRIOR } from './fixtures'

registerRollbackContract({
  label: 'identity-attributes',
  handler: rollback,
  restore: {
    entry: { name: NAME, existed: true, prior: PRIOR },
    method: 'PUT',
    path: '/beta/identity-attributes/costCenter',
    bodyIncludes: ['Cost Centre (legacy)', 'Legacy Cost Centre Rule'],
  },
  remove: {
    entry: { name: NAME, existed: false },
    method: 'DELETE',
    path: '/beta/identity-attributes/costCenter',
  },
  unrecoverable: [{ name: NAME, existed: true }],
})
