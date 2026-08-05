// =============================================================================
// Options provider for the Security Groups config type.
//
// "ownerPrincipals" reuses the SAME users+servicePrincipals alias
// applications/service-principals already established (see
// ../lib/principals.ts) — group.owners is documented as "users or service
// principals" too (https://learn.microsoft.com/graph/api/resources/group),
// the identical two-kind combination, so this is a straight reuse rather than
// a new merge.
//
// "groupMembers" is a NEW four-kind merge (users + groups + devices + service
// principals) — the kinds Graph's "Add members" table marks valid for a
// SECURITY group (https://learn.microsoft.com/graph/api/group-post-members).
// Unlike ownerPrincipals this alias is specific to this one config type (no
// other batch-4 type needs a 4-kind member merge), so it lives here rather
// than in a shared lib — see ../lib/nameMaps.ts's header for why small,
// single-consumer mechanics stay local instead of being generalized upfront.
// =============================================================================

import type { OptionItem, OptionsProvider, OptionsProviderContext } from '@veltrixsecops/app-sdk'
import entraOptions from '../lib/entraOptions'
import { ownerPrincipalOptions } from '../lib/principals'

function withKind(o: OptionItem, kind: string): OptionItem {
  return { ...o, label: `${o.label} (${kind})` }
}

async function groupMemberOptions(ctx: OptionsProviderContext): Promise<OptionItem[]> {
  const [users, groups, devices, servicePrincipals] = await Promise.all([
    entraOptions({ ...ctx, source: 'users' }),
    entraOptions({ ...ctx, source: 'groups' }),
    entraOptions({ ...ctx, source: 'devices' }),
    entraOptions({ ...ctx, source: 'servicePrincipals' }),
  ])
  return [
    ...users.map((o) => withKind(o, 'user')),
    ...groups.map((o) => withKind(o, 'group')),
    ...devices.map((o) => withKind(o, 'device')),
    ...servicePrincipals.map((o) => withKind(o, 'service principal')),
  ]
}

const groupOptions: OptionsProvider = async (ctx: OptionsProviderContext): Promise<OptionItem[]> => {
  if (ctx.source === 'ownerPrincipals') return ownerPrincipalOptions(ctx)
  if (ctx.source === 'groupMembers') return groupMemberOptions(ctx)
  return entraOptions(ctx)
}

export default groupOptions
