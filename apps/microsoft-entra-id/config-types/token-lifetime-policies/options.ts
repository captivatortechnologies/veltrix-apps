// =============================================================================
// Options provider for the Token Lifetime Policies config type.
//
// "appliesTo" routes straight through to entraOptions' existing
// "servicePrincipals" source — tokenLifetimePolicy assigns to service
// principals ONLY (https://learn.microsoft.com/graph/api/serviceprincipal-post-tokenlifetimepolicies),
// so no merge/alias is needed here.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
