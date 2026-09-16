// healthCheck for admin-consent-request-policy — the shared Entra probe contract, driven against a fake Graph.
//
// Every configuration type in this app health-checks the same way: resolve the
// app-registration credential, fail closed when it or the tenant id is missing,
// otherwise acquire a token and probe exactly ONE Graph endpoint. The shared
// contract asserts that sequence; this file pins the endpoint and check name.

import healthCheck from '../healthCheck'
import { registerHealthCheckContract } from '../../../lib/__tests__/graphContracts'
import { resource } from '../../../lib/__tests__/fakeGraph'

registerHealthCheckContract({
  label: 'admin-consent-request-policy',
  handler: healthCheck,
  checkName: 'graph-admin-consent-request-policy',
  path: '/policies/adminConsentRequestPolicy',
  // A tenant singleton — Graph returns the object itself, not a collection.
  probeResponse: resource({ id: 'authorizationPolicy' }),
})
