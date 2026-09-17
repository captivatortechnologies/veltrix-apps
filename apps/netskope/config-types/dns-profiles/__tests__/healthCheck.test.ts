// healthCheck for dns-profiles.
//
// Structurally identical in all 22 configuration types — read the settings, fail
// closed on an unusable credential or a missing tenant host, probe one endpoint,
// report reachability as a 0-100 percentage. The shared contract asserts all of
// that; only the endpoint is specific here.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/netskopeContracts'

registerHealthCheckContract({
  label: 'dns-profiles',
  handler: healthCheck,
  probePath: '/profiles/dns',
  checkName: 'netskope-dns-profiles',
})
