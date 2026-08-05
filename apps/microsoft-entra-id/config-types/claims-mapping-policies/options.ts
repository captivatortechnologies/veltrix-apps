// =============================================================================
// Options provider for the Claims Mapping Policies config type.
//
// "appliesTo" routes straight through to entraOptions' existing
// "servicePrincipals" source — claimsMappingPolicy assigns to service
// principals ONLY (see deploy.ts header for the verified citation), so no
// merge/alias is needed here, unlike app-management-policies' mixed picker.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
