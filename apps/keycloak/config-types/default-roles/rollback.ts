import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import { reconcileDefaultRoleComposites, resolveDefaultRoleId, type DefaultRolesProjection } from './_shared'

/**
 * Undo a default-roles deploy by re-reconciling the default role's composite
 * children back to the prior set captured in rollbackData (written by
 * deploy()). There is no create/delete branch here — only composite-membership
 * changes — so rollback is just another reconciliation, toward the prior state.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    priorRealmRoles?: string[]
    priorClientRoles?: Record<string, string[]>
  }

  if (!resolveGrant(credential)) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  const resolved = await resolveDefaultRoleId(admin)
  if ('error' in resolved) return { success: false, message: resolved.error }

  const desired: DefaultRolesProjection = {
    realmRoles: data.priorRealmRoles ?? [],
    clientRoles: data.priorClientRoles ?? {},
  }

  try {
    const { added, removed } = await reconcileDefaultRoleComposites(admin, resolved.id, desired)
    return {
      success: true,
      message: `Restored prior default-role composites: ${added} added back, ${removed} removed.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
