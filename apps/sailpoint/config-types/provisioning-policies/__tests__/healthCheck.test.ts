// healthCheck for provisioning-policies — the shared ISC probe contract.
//
// Every configuration type in this app health-checks the same way: resolve the
// OAuth client credential and the tenant, fail closed when either is missing,
// otherwise acquire a token and probe exactly ONE ISC endpoint. The shared contract
// asserts that sequence; this file pins the endpoint and check name.
//
// Provisioning policies are nested under a source, so reachability is probed
// against the parent sources collection.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/iscContracts'

registerHealthCheckContract({
  label: 'provisioning-policies',
  handler: healthCheck,
  checkName: 'isc-provisioning-policies',
  path: '/v3/sources',
})
