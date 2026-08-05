// =============================================================================
// Options provider for the Group Settings config type.
//
// "groupSettingTemplates" routes straight through to entraOptions' existing
// source (GET /groupSettingTemplates) — templateId is the only picker-able
// field on this canvas, so no merge/alias is needed here.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
