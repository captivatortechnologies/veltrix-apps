// =============================================================================
// Options provider for the Access Review Definitions config type.
//
// Every reference field here (scopeGroupId, scopeRoleDefinitionId,
// scopeAccessPackageId, scopeServicePrincipalId, the reviewer/fallback-reviewer
// user and group pickers) routes straight through to entraOptions' existing
// sources (groups/roleDefinitions/accessPackages/servicePrincipals/users) — no
// alias or sentinel wrapping is needed.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
