// =============================================================================
// Options provider for the Entitlement Assignment Policies config type.
//
// Every reference field here (accessPackageId, the Specific Targets pickers,
// the on-behalf-of requestor pickers, the primary approver pickers) routes
// straight through to entraOptions' existing sources
// (accessPackages/users/groups/servicePrincipals/connectedOrganizations) — no
// alias or sentinel wrapping is needed, unlike conditional-access-policies'
// options.ts.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
