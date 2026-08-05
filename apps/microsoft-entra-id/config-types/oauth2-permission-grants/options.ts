// =============================================================================
// Options provider for the Delegated Permission Grants config type.
//
// clientId and resourceId route straight through to entraOptions' existing
// "servicePrincipals" source (object id) — oAuth2PermissionGrant.clientId and
// .resourceId are both documented as service-principal object ids, never
// appId (https://learn.microsoft.com/graph/api/resources/oauth2permissiongrant).
// principalId routes to entraOptions' "users" source — principalId is a
// user object id, meaningful only when consentType is Principal.
//
// No aliasing/sentinels needed here (unlike conditional-access-policies'
// options.ts): all three optionsSource values already match an existing
// entraOptions source name exactly, so this is a pure passthrough.
// =============================================================================

import entraOptions from '../lib/entraOptions'

export default entraOptions
