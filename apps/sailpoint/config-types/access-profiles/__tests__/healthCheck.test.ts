// healthCheck for access-profiles — the shared ISC probe contract.
//
// Every configuration type in this app health-checks the same way: resolve the
// OAuth client credential and the tenant, fail closed when either is missing,
// otherwise acquire a token and probe exactly ONE ISC endpoint. The shared
// contract asserts that sequence; this file pins the endpoint and check name.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/iscContracts'

registerHealthCheckContract({
  label: 'access-profiles',
  handler: healthCheck,
  checkName: 'isc-access-profiles',
  path: '/v3/access-profiles',
})
