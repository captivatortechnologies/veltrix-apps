// =============================================================================
// "directoryPrincipals" — a merged live picker + id-aware resolver over the
// THREE principal kinds unifiedRoleAssignment.principalId and
// unifiedRoleEligibilityScheduleRequest.principalId document as valid:
// "Identifier of the principal to which the assignment is granted. Supported
// principals are users, role-assignable groups, and service principals."
// (https://learn.microsoft.com/graph/api/resources/unifiedroleassignment)
//
// entraOptions has no single Graph collection for "a principal" — this merges
// its existing users/groups/servicePrincipals sources into one alias,
// labelling each option by kind so two same-named entities of different
// kinds (e.g. a user and a group both called "Ops") stay distinguishable in
// the picker. All three entraOptions sources already surface their OBJECT id
// as `value` (never appId) — the exact id space principalId expects.
//
// Used by directory-role-assignments and pim-role-eligibility, the two
// config types whose identity includes a principal.
// =============================================================================

import type { OptionItem, OptionsProviderContext } from '@veltrixsecops/app-sdk'
import type { GraphClient } from '../../lib/graph'
import entraOptions from './entraOptions'
import {
  buildGroupNameToId,
  buildServicePrincipalNameToId,
  buildUserNameToId,
  resolveAcrossMaps,
  resolveAcrossMapsMany,
} from './nameMaps'

function withKind(o: OptionItem, kind: string): OptionItem {
  return { ...o, label: `${o.label} (${kind})` }
}

/** Live options for the merged "directoryPrincipals" alias source. */
export async function directoryPrincipalOptions(ctx: OptionsProviderContext): Promise<OptionItem[]> {
  const [users, groups, servicePrincipals] = await Promise.all([
    entraOptions({ ...ctx, source: 'users' }),
    entraOptions({ ...ctx, source: 'groups' }),
    entraOptions({ ...ctx, source: 'servicePrincipals' }),
  ])
  return [
    ...users.map((o) => withKind(o, 'user')),
    ...groups.map((o) => withKind(o, 'group')),
    ...servicePrincipals.map((o) => withKind(o, 'service principal')),
  ]
}

export interface PrincipalNameMaps {
  user: Map<string, string>
  group: Map<string, string>
  servicePrincipal: Map<string, string>
}

/** Build all three principal name maps once per deploy/drift run. */
export async function buildPrincipalNameMaps(client: GraphClient): Promise<PrincipalNameMaps> {
  const [user, group, servicePrincipal] = await Promise.all([
    buildUserNameToId(client),
    buildGroupNameToId(client),
    buildServicePrincipalNameToId(client),
  ])
  return { user, group, servicePrincipal }
}

const mapOrder = (maps: PrincipalNameMaps): Array<Map<string, string>> => [maps.user, maps.group, maps.servicePrincipal]

/** GUID passthrough; else resolve a hand-typed display name/UPN, trying user -> group -> service principal. */
export function resolvePrincipal(value: string, maps: PrincipalNameMaps): { id: string; missing: boolean } {
  return resolveAcrossMaps(value, mapOrder(maps))
}

/** Batch form of resolvePrincipal, for a multiselect field. */
export function resolvePrincipals(values: string[], maps: PrincipalNameMaps): { ids: string[]; missing: string[] } {
  return resolveAcrossMapsMany(values, mapOrder(maps))
}
