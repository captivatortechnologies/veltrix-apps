// healthCheck for home-realm-discovery-policies — the shared Entra probe contract, driven against a fake Graph.
//
// Every configuration type in this app health-checks the same way: resolve the
// app-registration credential, fail closed when it or the tenant id is missing,
// otherwise acquire a token and probe exactly ONE Graph endpoint. The shared
// contract asserts that sequence; this file pins the endpoint and check name.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/graphContracts'

registerHealthCheckContract({
  label: 'home-realm-discovery-policies',
  handler: healthCheck,
  checkName: 'graph-home-realm-discovery-policies',
  path: '/policies/homeRealmDiscoveryPolicies',
})
