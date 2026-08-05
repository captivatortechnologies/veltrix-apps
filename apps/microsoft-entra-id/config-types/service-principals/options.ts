// =============================================================================
// Options provider for the Service Principals config type.
//
// "owners" merges users + service principals (NOT groups — see
// config-types/lib/principals.ts's "ownerPrincipals" section for the verified
// Graph citations). Every other field on this canvas is plain text/textarea
// (no live picker), so this only ever needs to handle the one alias source.
// =============================================================================

import type { OptionItem, OptionsProvider, OptionsProviderContext } from '@veltrixsecops/app-sdk'
import entraOptions from '../lib/entraOptions'
import { ownerPrincipalOptions } from '../lib/principals'

const servicePrincipalOptions: OptionsProvider = async (ctx: OptionsProviderContext): Promise<OptionItem[]> => {
  if (ctx.source === 'ownerPrincipals') return ownerPrincipalOptions(ctx)
  return entraOptions(ctx)
}

export default servicePrincipalOptions
