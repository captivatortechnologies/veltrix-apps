// healthCheck for flow-custom-properties — the shared contract.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/qradarContracts'

registerHealthCheckContract({
  label: 'flow-custom-properties',
  handler: healthCheck,
  probePath: '/config/flow_sources/custom_properties/regex_properties',
  checkName: 'qradar-flow-custom-properties',
})
