// rollback for ISC MFA method configuration.
//
// The provider secret cannot be read back, so there is no "restore" here — only
// "undo the enabling". A method this deploy turned on from off is turned off
// again; a method the tenant already had on is left exactly where it is, because
// disabling it would take multi-factor authentication away from everyone and the
// secret needed to put it back was never readable.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { DELETE_PATH, METHOD } from './fixtures'

registerRollbackContract({
  label: 'mfa-configs',
  handler: rollback,
  remove: {
    entry: { method: METHOD, priorEnabled: false },
    method: 'DELETE',
    path: DELETE_PATH,
  },
  unrecoverable: [
    // The tenant had this method on before the deploy — its prior secret cannot
    // be restored, so turning it off is not an undo, it is an outage.
    { method: METHOD, priorEnabled: true },
  ],
})
