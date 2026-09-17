// getStatus for zpa-service-edge-groups — the shared contract.
//
// getStatus is byte-identical in all 33 configuration types of this app: it
// reads the platform's own deployment record plus the registered zscaler-tenant
// components, and must never reach Zscaler.

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/zscalerContracts'

registerGetStatusContract({
  label: 'zpa-service-edge-groups',
  handler: getStatus,
  configTypeId: 'zpa-service-edge-groups',
})
