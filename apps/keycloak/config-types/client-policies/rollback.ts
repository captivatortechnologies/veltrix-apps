import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import type { ClientPolicyRepresentation } from './_shared'
import type { ClientPoliciesRollbackData } from './deploy'

/**
 * Roll back client policies using the state captured during deploy: restore the exact
 * prior custom-policy list with ONE PUT of `{ policies: rollbackData.priorPolicies }`
 * (never `globalPolicies` — see _shared.ts). A prior list of zero policies is a valid
 * state to restore to, so an empty array is not treated as "nothing to roll back" —
 * only a genuinely missing `rollbackData` is.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = ctx.rollbackData as ClientPoliciesRollbackData | undefined
  const priorPolicies: ClientPolicyRepresentation[] | undefined = data?.priorPolicies
  if (!priorPolicies) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  if (!resolveGrant(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  try {
    const res = await admin.put('/client-policies/policies', { policies: priorPolicies })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return { success: true, message: `Rolled back client policies to the prior list of ${priorPolicies.length} polic${priorPolicies.length === 1 ? 'y' : 'ies'}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
