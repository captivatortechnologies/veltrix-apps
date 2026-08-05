// =============================================================================
// Options provider for the Feature Rollout Policies config type.
//
// "appliesTo" routes straight through to entraOptions' existing "groups"
// source — featureRolloutPolicy.appliesTo supports GROUPS ONLY ("The
// appliesTo field only supports groups", see
// https://learn.microsoft.com/graph/api/resources/featurerolloutpolicy), so
// no merge/alias is needed here.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
