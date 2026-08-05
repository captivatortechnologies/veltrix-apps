// =============================================================================
// Options provider for the Self-Service Sign-Up User Flows config type.
//
// "identityProviders" and "userFlowAttributes" both route straight through to
// entraOptions' existing sources (GET /identity/identityProviders and GET
// /identity/userFlowAttributes respectively) — neither needs a merge/alias.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
