// driftDetect for custom-event-properties — the shared custom-property contract.

import driftDetect from '../driftDetect'
import { registerCustomPropertyDriftContract } from '../../../lib/__tests__/customPropertiesContracts'

registerCustomPropertyDriftContract({
  label: 'custom-event-properties',
  base: 'event_sources',
  handler: driftDetect,
})
