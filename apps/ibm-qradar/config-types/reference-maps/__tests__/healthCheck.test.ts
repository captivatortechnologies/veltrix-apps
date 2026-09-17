// healthCheck for reference-maps — the shared contract.
//
// Every QRadar config type probes ONE list endpoint with `Range: items=0-0` and
// scores it 100 or 0. The contract asserts the refusals (no credential, no
// token, no console host), the SEC + Version headers, the exact probe path, that
// the probe never writes, and that a rejected token is reported without being
// echoed back.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/qradarContracts'

registerHealthCheckContract({
  label: 'reference-maps',
  handler: healthCheck,
  probePath: '/reference_data/maps',
  checkName: 'qradar-reference-maps',
})
