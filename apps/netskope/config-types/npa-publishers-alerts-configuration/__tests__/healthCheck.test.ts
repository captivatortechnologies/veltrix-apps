// healthCheck for npa-publishers-alerts-configuration.
//
// Structurally identical in all 22 configuration types — read the settings, fail
// closed on an unusable credential or a missing tenant host, probe one endpoint,
// report reachability as a 0-100 percentage. The shared contract asserts all of
// that; only the endpoint, the 404-is-still-reachable rule is specific here.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/netskopeContracts'

registerHealthCheckContract({
  label: 'npa-publishers-alerts-configuration',
  handler: healthCheck,
  probePath: '/infrastructure/publishers/alertsconfiguration',
  checkName: 'netskope-npa-publishers-alerts-configuration',
  paged: false,
  // A tenant that never configured this endpoint answers 404 — still reachable.
  tolerates404: true,
})
