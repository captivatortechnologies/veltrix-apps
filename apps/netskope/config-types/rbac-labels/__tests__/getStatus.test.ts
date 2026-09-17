// getStatus for rbac-labels — the shared contract.
//
// getStatus is identical in all 22 configuration types of this app: it reads the
// platform's own deployment record and reports the registered tenant, and must
// never reach Netskope. The shared contract asserts that, the SUCCEEDED-only
// query, the completedAt/startedAt fallback, and that a failed platform lookup
// reports "not deployed" rather than crashing the pipeline.

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/netskopeContracts'

registerGetStatusContract({
  label: 'rbac-labels',
  handler: getStatus,
  configTypeId: 'rbac-labels',
})
