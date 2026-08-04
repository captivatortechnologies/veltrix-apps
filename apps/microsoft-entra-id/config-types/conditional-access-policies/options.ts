// =============================================================================
// Options provider for the Conditional Access Policies config type.
//
// Most optionsSource values here route straight through, unchanged, to the
// shared live-picker logic in config-types/lib/entraOptions — see that
// module's header for the full source -> Graph endpoint table:
//   groups, applications, roleDefinitions, namedLocations,
//   authStrengthPolicies, termsOfUse, users
//
// This file exists only to prepend Graph-documented SENTINEL literals ahead
// of the live list for a handful of fields, and — critically — those
// sentinels differ between the INCLUDE and EXCLUDE side of the very same
// entraOptions source:
//   - conditionalAccessUsers.includeUsers documents `All`, `None`, and
//     `GuestsOrExternalUsers`; excludeUsers documents only
//     `GuestsOrExternalUsers`
//     (https://learn.microsoft.com/graph/api/resources/conditionalaccessusers)
//   - conditionalAccessLocations.includeLocations documents `All` and
//     `AllTrusted`; excludeLocations documents no sentinel at all
//     (https://learn.microsoft.com/graph/api/resources/conditionalaccesslocations)
//
// entraOptions' OptionsProviderContext only carries the field's
// `optionsSource` string — it has no idea which CANVAS FIELD asked, so it
// can't express "same Graph collection, different sentinel set depending on
// include vs exclude" on its own, and per this phase's brief entraOptions.ts
// itself is not to be touched. So the include/exclude sides of "users" and
// "namedLocations" are wired to distinct alias source ids below
// (usersInclude/usersExclude, namedLocationsInclude/namedLocations) that
// resolve to the SAME underlying entraOptions source but get their own
// sentinel treatment. Roles have no CA sentinel at all, so includeRoles and
// excludeRoles both just use the plain "roleDefinitions" source untouched.
//
// KNOWN GAP (Graph, not this code): GET /identityGovernance/termsOfUse/agreements
// documents Application permission as "Not supported" — only a delegated
// work-or-school token with Agreement.Read.All can list agreements
// (https://learn.microsoft.com/graph/api/termsofusecontainer-list-agreements).
// This app authenticates as an app registration via OAuth2 client credentials
// only (see ../../lib/graph header), so the "termsOfUse" live picker will
// come back empty/error in every real deployment of this app — there is no
// application-permission fix on Graph's side. The field still works: a
// hand-typed agreement id (a GUID, e.g. copied from the Entra admin center)
// passes straight through the id-aware resolver in deploy.ts without needing
// the live list. See the field's helpText in canvas.yaml.
// =============================================================================

import type { OptionItem, OptionsProvider, OptionsProviderContext } from '@veltrixsecops/app-sdk'
import entraOptions from '../lib/entraOptions'

/** Narrow a fixed sentinel list by the field's free-text query — same rule entraOptions uses internally. */
function filterByLabel(items: OptionItem[], query: string): OptionItem[] {
  const needle = query.trim().toLowerCase()
  return needle ? items.filter((o) => o.label.toLowerCase().includes(needle)) : items
}

/**
 * conditionalAccessUsers.includeUsers: "User IDs in scope of policy unless
 * explicitly excluded, `None`, `All`, or `GuestsOrExternalUsers`."
 * (https://learn.microsoft.com/graph/api/resources/conditionalaccessusers)
 */
const INCLUDE_USER_SENTINELS: OptionItem[] = [
  { value: 'All', label: 'All users (All)', description: 'Every user in the tenant' },
  { value: 'None', label: 'No users (None)', description: 'Target nobody with this policy' },
  {
    value: 'GuestsOrExternalUsers',
    label: 'Guests or external users (GuestsOrExternalUsers)',
    description: 'Every guest and external user type',
  },
]

/**
 * conditionalAccessUsers.excludeUsers: "User IDs excluded from scope of
 * policy and/or `GuestsOrExternalUsers`." `All`/`None` are NOT documented on
 * the exclude side (excluding "every user" or "no user" isn't a meaningful
 * exclusion) — same "don't offer what Graph doesn't document" rule
 * entraOptions' CLOUD_APP_SENTINELS already applies to "None" for apps.
 */
const EXCLUDE_USER_SENTINELS: OptionItem[] = [
  {
    value: 'GuestsOrExternalUsers',
    label: 'Guests or external users (GuestsOrExternalUsers)',
    description: 'Every guest and external user type',
  },
]

/**
 * conditionalAccessLocations.includeLocations: "Location IDs in scope of
 * policy unless explicitly excluded, `All`, or `AllTrusted`."
 * (https://learn.microsoft.com/graph/api/resources/conditionalaccesslocations)
 * excludeLocations documents no sentinel ("Location IDs excluded from scope
 * of policy.") — so the exclude side gets the plain "namedLocations" source,
 * live list only, no prepended sentinels.
 */
const INCLUDE_LOCATION_SENTINELS: OptionItem[] = [
  { value: 'All', label: 'All locations (All)', description: 'Every network location, known or unknown' },
  {
    value: 'AllTrusted',
    label: 'All trusted locations (AllTrusted)',
    description: 'Every named location marked "trusted" in Named Locations',
  },
]

/** Maps a CA-specific field alias to the entraOptions source it actually fetches from Graph. */
const SOURCE_ALIASES: Record<string, string> = {
  usersInclude: 'users',
  usersExclude: 'users',
  namedLocationsInclude: 'namedLocations',
}

const conditionalAccessOptions: OptionsProvider = async (ctx: OptionsProviderContext): Promise<OptionItem[]> => {
  const canonicalSource = SOURCE_ALIASES[ctx.source] ?? ctx.source
  const items = await entraOptions({ ...ctx, source: canonicalSource })
  const query = ctx.query ?? ''

  switch (ctx.source) {
    case 'usersInclude':
      return [...filterByLabel(INCLUDE_USER_SENTINELS, query), ...items]
    case 'usersExclude':
      return [...filterByLabel(EXCLUDE_USER_SENTINELS, query), ...items]
    case 'namedLocationsInclude':
      return [...filterByLabel(INCLUDE_LOCATION_SENTINELS, query), ...items]
    default:
      return items
  }
}

export default conditionalAccessOptions
