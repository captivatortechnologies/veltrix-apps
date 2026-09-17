// getStatus for lifecycle-states — the shared contract.
//
// getStatus is identical in all 31 configuration types of this app: it reads the
// platform's own deployment record and must never reach ISC. The shared contract
// asserts that, the SUCCEEDED-only query, the completedAt/startedAt fallback, and
// that a platform lookup failure degrades to "not deployed".

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/iscContracts'

registerGetStatusContract({
  label: 'lifecycle-states',
  handler: getStatus,
  configTypeId: 'lifecycle-states',
})
