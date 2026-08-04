// =============================================================================
// Options provider for the Directory Role Assignments config type.
//
// roleDefinitionId routes straight through to entraOptions' "roleDefinitions"
// source — a built-in role's id there IS the roleTemplateId this field needs
// (see deploy.ts). principalId and directoryScopeId are per-field alias
// sources composed from multiple entraOptions calls; entraOptions itself
// can't express either directly (no single Graph collection covers "a
// principal", and directoryScopeId needs values prefixed/reshaped per source)
// — see config-types/lib/principals.ts and config-types/lib/directoryScope.ts.
// =============================================================================

import type { OptionItem, OptionsProvider, OptionsProviderContext } from '@veltrixsecops/app-sdk'
import entraOptions from '../lib/entraOptions'
import { directoryPrincipalOptions } from '../lib/principals'
import { directoryScopeOptions } from '../lib/directoryScope'

const directoryRoleAssignmentOptions: OptionsProvider = async (ctx: OptionsProviderContext): Promise<OptionItem[]> => {
  switch (ctx.source) {
    case 'directoryPrincipals':
      return directoryPrincipalOptions(ctx)
    case 'directoryScope':
      return directoryScopeOptions(ctx)
    default:
      return entraOptions(ctx)
  }
}

export default directoryRoleAssignmentOptions
