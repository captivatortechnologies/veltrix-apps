// healthCheck for tenant-config-singletons — the shared ISC probe contract.
//
// Every configuration type in this app health-checks the same way: resolve the
// OAuth client credential and the tenant, fail closed when either is missing,
// otherwise acquire a token and probe exactly ONE ISC endpoint. The shared contract
// asserts that sequence; this file pins the endpoint and check name.
//
// These are tenant singletons with no collection to list, so reachability is probed
// against one stable singleton, which answers with the object rather than an array.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/iscContracts'
import { resource } from '../../../lib/__tests__/fakeIsc'

registerHealthCheckContract({
  label: 'tenant-config-singletons',
  handler: healthCheck,
  checkName: 'isc-tenant-config',
  path: '/v3/password-org-config',
  probeResponse: resource({ customInstructionsEnabled: true }),
})
