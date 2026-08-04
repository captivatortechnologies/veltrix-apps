// =============================================================================
// Options provider for the PIM Role Eligibility config type.
//
// roleDefinitionId routes straight through to entraOptions' "roleDefinitions"
// source. principalId and directoryScopeId are per-field alias sources
// composed from multiple entraOptions calls — see config-types/lib/principals.ts
// and config-types/lib/directoryScope.ts (shared with directory-role-assignments,
// the sibling config type with the identical principal/scope shape).
// =============================================================================

import type { OptionItem, OptionsProvider, OptionsProviderContext } from '@veltrixsecops/app-sdk'
import entraOptions from '../lib/entraOptions'
import { directoryPrincipalOptions } from '../lib/principals'
import { directoryScopeOptions } from '../lib/directoryScope'

const pimRoleEligibilityOptions: OptionsProvider = async (ctx: OptionsProviderContext): Promise<OptionItem[]> => {
  switch (ctx.source) {
    case 'directoryPrincipals':
      return directoryPrincipalOptions(ctx)
    case 'directoryScope':
      return directoryScopeOptions(ctx)
    default:
      return entraOptions(ctx)
  }
}

export default pimRoleEligibilityOptions
