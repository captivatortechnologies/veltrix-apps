// healthCheck for npa-local-broker-config.
//
// Structurally identical in all 22 configuration types — read the settings, fail
// closed on an unusable credential or a missing tenant host, probe one endpoint,
// report reachability as a 0-100 percentage. The shared contract asserts all of
// that; only the endpoint, the un-paged single-object probe is specific here.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/netskopeContracts'

registerHealthCheckContract({
  label: 'npa-local-broker-config',
  handler: healthCheck,
  probePath: '/infrastructure/lbrokers/brokerconfig',
  checkName: 'netskope-npa-local-broker-config',
  paged: false,
})
