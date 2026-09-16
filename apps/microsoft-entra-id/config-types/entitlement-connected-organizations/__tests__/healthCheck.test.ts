// healthCheck for entitlement-connected-organizations — the shared Entra probe contract, driven against a fake Graph.
//
// Every configuration type in this app health-checks the same way: resolve the
// app-registration credential, fail closed when it or the tenant id is missing,
// otherwise acquire a token and probe exactly ONE Graph endpoint. The shared
// contract asserts that sequence; this file pins the endpoint and check name.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/graphContracts'

registerHealthCheckContract({
  label: 'entitlement-connected-organizations',
  handler: healthCheck,
  checkName: 'graph-connected-organizations',
  path: '/identityGovernance/entitlementManagement/connectedOrganizations',
})
