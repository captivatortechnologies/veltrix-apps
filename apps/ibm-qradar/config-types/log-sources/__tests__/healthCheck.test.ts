// healthCheck for log-sources — the shared contract.
//
// Every QRadar config type probes ONE list endpoint with `Range: items=0-0` and
// scores it 100 or 0. The contract asserts the refusals (no credential, no
// token, no console host), the SEC + Version headers, the exact probe path, that
// the probe never writes, and that a rejected token is reported without being
// echoed back.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/qradarContracts'

registerHealthCheckContract({
  label: 'log-sources',
  handler: healthCheck,
  probePath: '/config/event_sources/log_source_management/log_sources',
  checkName: 'qradar-log-sources',
})
