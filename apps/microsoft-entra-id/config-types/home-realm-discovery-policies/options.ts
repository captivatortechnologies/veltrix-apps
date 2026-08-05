// =============================================================================
// Options provider for the Home Realm Discovery Policies config type.
//
// "appliesTo" routes straight through to entraOptions' existing
// "servicePrincipals" source — homeRealmDiscoveryPolicy assigns to service
// principals ONLY (https://learn.microsoft.com/graph/api/serviceprincipal-post-homerealmdiscoverypolicies),
// so no merge/alias is needed here.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
