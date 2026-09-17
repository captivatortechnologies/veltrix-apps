// healthCheck for custom-event-properties — the shared contract.
//
// `makeHealthCheck('event_sources', ...)` probes the regex-properties endpoint
// this type writes, so the probe also proves the authorized service holds the
// capability the deploy needs.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/qradarContracts'

registerHealthCheckContract({
  label: 'custom-event-properties',
  handler: healthCheck,
  probePath: '/config/event_sources/custom_properties/regex_properties',
  checkName: 'qradar-custom-event-properties',
})
