// healthCheck for network-hierarchy — the shared contract.
//
// The staged-networks endpoint is the one this config type writes, so probing it
// also proves the authorized service holds the capability the deploy needs.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/qradarContracts'

registerHealthCheckContract({
  label: 'network-hierarchy',
  handler: healthCheck,
  probePath: '/config/network_hierarchy/staged_networks',
  checkName: 'qradar-network-hierarchy',
})
