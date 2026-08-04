import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { projectFromFields, reconcileDefaultRoleComposites, resolveDefaultRoleId, type DefaultRolesProjection } from './_shared'

/**
 * Deploy the realm's default-role composite children over the Admin REST API
 * (SINGLETON — one item, no list/match):
 *   resolve: GET    /admin/realms/{realm}                             → .defaultRole.id
 *   read:    GET    /admin/realms/{realm}/roles-by-id/{id}/composites  → current children
 *   add:     POST   /admin/realms/{realm}/roles-by-id/{id}/composites
 *   remove:  DELETE /admin/realms/{realm}/roles-by-id/{id}/composites
 *
 * There is no object to create or delete here — only composite-membership
 * changes on Keycloak's own default role — so rollbackData captures the PRIOR
 * composite set (realm role names + a clientId→role-names map) and rollback
 * re-reconciles back toward it.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]

  if (!item) return { success: false, message: 'No default-roles configuration provided.' }
  if (!resolveGrant(credential)) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  const resolved = await resolveDefaultRoleId(admin)
  if ('error' in resolved) return { success: false, message: resolved.error }

  const desired: DefaultRolesProjection = projectFromFields(item.fields)

  try {
    const { prior, added, removed } = await reconcileDefaultRoleComposites(admin, resolved.id, desired)
    return {
      success: true,
      message: `Reconciled default-role composites: ${added} added, ${removed} removed (${desired.realmRoles.length} realm role(s), ${Object.keys(desired.clientRoles).length} client(s) with roles).`,
      artifacts: { realmRoles: desired.realmRoles, clientRoles: desired.clientRoles },
      rollbackData: { priorRealmRoles: prior.realmRoles, priorClientRoles: prior.clientRoles },
    }
  } catch (error) {
    return {
      success: false,
      message: `Default-roles deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
