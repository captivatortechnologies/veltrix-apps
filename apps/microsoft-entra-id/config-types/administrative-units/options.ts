// =============================================================================
// Options provider for the Administrative Units config type.
//
// "members" merges users + groups + devices — administrativeUnit.members is
// documented as holding all three: "An administrative unit provides a
// conceptual container for user, group, and device directory objects"
// (https://learn.microsoft.com/graph/api/resources/administrativeunit), and
// the list-members example response confirms devices come back as ordinary
// members (`"@odata.type": "#microsoft.graph.device"`) alongside users/groups
// (https://learn.microsoft.com/graph/api/administrativeunit-list-members).
// entraOptions has no single Graph collection for this, so — same approach as
// ../lib/principals.ts's "directoryPrincipals" — this merges three of its
// existing sources into one alias, labelling each option by kind.
// =============================================================================

import type { OptionItem, OptionsProvider, OptionsProviderContext } from '@veltrixsecops/app-sdk'
import entraOptions from '../lib/entraOptions'

function withKind(o: OptionItem, kind: string): OptionItem {
  return { ...o, label: `${o.label} (${kind})` }
}

const administrativeUnitOptions: OptionsProvider = async (ctx: OptionsProviderContext): Promise<OptionItem[]> => {
  if (ctx.source !== 'administrativeUnitMembers') return entraOptions(ctx)

  const [users, groups, devices] = await Promise.all([
    entraOptions({ ...ctx, source: 'users' }),
    entraOptions({ ...ctx, source: 'groups' }),
    entraOptions({ ...ctx, source: 'devices' }),
  ])
  return [
    ...users.map((o) => withKind(o, 'user')),
    ...groups.map((o) => withKind(o, 'group')),
    ...devices.map((o) => withKind(o, 'device')),
  ]
}

export default administrativeUnitOptions
