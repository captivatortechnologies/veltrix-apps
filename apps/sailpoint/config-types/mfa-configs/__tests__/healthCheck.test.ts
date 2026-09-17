// healthCheck for mfa-configs — the shared ISC probe contract.
//
// Every configuration type in this app health-checks the same way: resolve the
// OAuth client credential and the tenant, fail closed when either is missing,
// otherwise acquire a token and probe exactly ONE ISC endpoint. The shared contract
// asserts that sequence; this file pins the endpoint and check name.
//
// There is no MFA collection to list, so reachability is probed against a stable
// per-method singleton, which answers with the object rather than an array.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/iscContracts'
import { resource } from '../../../lib/__tests__/fakeIsc'

registerHealthCheckContract({
  label: 'mfa-configs',
  handler: healthCheck,
  checkName: 'isc-mfa-config',
  path: '/v3/mfa/okta-verify/config',
  probeResponse: resource({ mfaMethod: 'okta-verify', enabled: true }),
})
