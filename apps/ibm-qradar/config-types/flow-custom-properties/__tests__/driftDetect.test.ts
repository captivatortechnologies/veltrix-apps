// driftDetect for flow-custom-properties — the shared custom-property contract.

import driftDetect from '../driftDetect'
import { registerCustomPropertyDriftContract } from '../../../lib/__tests__/customPropertiesContracts'

registerCustomPropertyDriftContract({
  label: 'flow-custom-properties',
  base: 'flow_sources',
  handler: driftDetect,
})
