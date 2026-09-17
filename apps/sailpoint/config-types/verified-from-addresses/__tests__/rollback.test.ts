// rollback for ISC verified from-addresses.
//
// There is nothing to restore here — an address cannot be updated — so rollback
// only removes what this app registered. An address the tenant already had must
// be left alone: deleting it would silently break whatever notifications send
// from it, and re-adding it needs a human to click a verification link.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { BASE, EMAIL, LIVE_ID } from './fixtures'

registerRollbackContract({
  label: 'verified-from-addresses',
  handler: rollback,
  remove: {
    entry: { email: EMAIL, existed: false, id: 'vfa-created' },
    method: 'DELETE',
    path: `${BASE}/vfa-created`,
  },
  unrecoverable: [
    // The tenant already had this address — it is not ours to delete.
    { email: EMAIL, existed: true, id: LIVE_ID },
    // Registered by us, but the vendor response carried no id.
    { email: EMAIL, existed: false },
  ],
})
