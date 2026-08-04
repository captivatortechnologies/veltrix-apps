// =============================================================================
// Options provider for the Entitlement Access Packages config type.
//
// Its only reference field (catalogId) routes straight through to entraOptions'
// "accessPackageCatalogs" source — no alias or sentinel wrapping needed.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
