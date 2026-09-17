// healthCheck for lifecycle-states — the shared ISC probe contract.
//
// Every configuration type in this app health-checks the same way: resolve the
// OAuth client credential and the tenant, fail closed when either is missing,
// otherwise acquire a token and probe exactly ONE ISC endpoint. The shared contract
// asserts that sequence; this file pins the endpoint and check name.
//
// Lifecycle states are nested under an identity profile, so reachability is probed
// against the parent identity-profiles collection.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/iscContracts'

registerHealthCheckContract({
  label: 'lifecycle-states',
  handler: healthCheck,
  checkName: 'isc-lifecycle-states',
  path: '/v3/identity-profiles',
})
