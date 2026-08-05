// =============================================================================
// Options provider for the Application Management Policies config type.
//
// "appliesTo" merges applications (object id) + service principals — the one
// policy type in this batch assignable to EITHER kind. See
// config-types/lib/policyAppliesTo.ts for the full verified endpoint table.
// =============================================================================

import type { OptionItem, OptionsProvider, OptionsProviderContext } from '@veltrixsecops/app-sdk'
import entraOptions from '../lib/entraOptions'
import { applicationOrServicePrincipalOptions } from '../lib/policyAppliesTo'

const appManagementPolicyOptions: OptionsProvider = async (ctx: OptionsProviderContext): Promise<OptionItem[]> => {
  if (ctx.source === 'applicationOrServicePrincipal') return applicationOrServicePrincipalOptions(ctx)
  return entraOptions(ctx)
}

export default appManagementPolicyOptions
