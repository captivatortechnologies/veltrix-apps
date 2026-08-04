// =============================================================================
// Options provider for the PIM Role Management Policies config type.
//
// Its only reference field (roleDefinitionId) routes straight through to
// entraOptions' "roleDefinitions" source — no CA-style sentinel or per-field
// alias is needed here, unlike the sibling config types in this batch.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
