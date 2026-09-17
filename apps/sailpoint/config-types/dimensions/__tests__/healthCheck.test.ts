// healthCheck for dimensions — the shared ISC probe contract.
//
// Every configuration type in this app health-checks the same way: resolve the
// OAuth client credential and the tenant, fail closed when either is missing,
// otherwise acquire a token and probe exactly ONE ISC endpoint. The shared contract
// asserts that sequence; this file pins the endpoint and check name.
//
// Dimensions are nested under a role, so reachability is probed against the parent
// roles collection rather than a dimensions endpoint of their own.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/iscContracts'

registerHealthCheckContract({
  label: 'dimensions',
  handler: healthCheck,
  checkName: 'isc-dimensions',
  path: '/v3/roles',
})
