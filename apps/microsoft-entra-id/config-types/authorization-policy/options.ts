// =============================================================================
// Options provider for the Tenant Authorization Policy config type.
//
// "permissionGrantPolicies" routes straight through to entraOptions' existing
// source (GET /policies/permissionGrantPolicies) — it's the only picker-able
// field on this canvas, so no merge/alias is needed here.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
