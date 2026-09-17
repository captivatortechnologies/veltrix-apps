// getStatus for zia-locations — the shared contract.
//
// getStatus is byte-identical in all 33 configuration types of this app: it
// reads the platform's own deployment record plus the registered zscaler-tenant
// components, and must never reach Zscaler. The shared contract asserts that,
// the SUCCEEDED-only query, the component-type filter, the completedAt/startedAt
// fallback and the 80-point health threshold.

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/zscalerContracts'

registerGetStatusContract({
  label: 'zia-locations',
  handler: getStatus,
  configTypeId: 'zia-locations',
})
