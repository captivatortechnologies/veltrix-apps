// =============================================================================
// Options provider for the Token Issuance Policies config type.
//
// "appliesTo" routes straight through to entraOptions' existing
// "applicationObjects" source (object id) — tokenIssuancePolicy assigns to
// APPLICATIONS ONLY (see deploy.ts header for the verified citation: the
// service-principal assign operation does not exist for this policy type,
// despite what its own resource page's boilerplate property text claims).
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
