// getStatus for admin-consent-request-policy — the shared contract.
//
// getStatus is byte-identical in all 42 configuration types of this app: it reads
// the platform's own deployment record and must never reach Graph. The shared
// contract asserts that, the SUCCEEDED-only query, the completedAt/startedAt
// fallback, and that a platform lookup failure degrades to "not deployed".

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/graphContracts'

registerGetStatusContract({
  label: 'admin-consent-request-policy',
  handler: getStatus,
  configTypeId: 'admin-consent-request-policy',
})
