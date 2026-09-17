// getStatus for cloud-compliance-controls — the shared contract.
//
// getStatus is identical in all 44 configuration types of this app (only its doc
// comment differs): it reads the platform's own deployment record plus the
// registered `falcon-tenant` components, and must never reach Falcon. The shared
// contract asserts that, the SUCCEEDED-only query, the component-type filter,
// the completedAt/startedAt fallback and the 80-point health threshold.

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/falconContracts'

registerGetStatusContract({
  label: 'cloud-compliance-controls',
  handler: getStatus,
  configTypeId: 'cloud-compliance-controls',
})
