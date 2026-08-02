import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  sendJson,
  deleteResource,
} from '../../lib/auth0Api'
import type { Auth0Permission, RoleBody } from './_shared'
import { reconcileRolePermissions } from './permissions'

/**
 * Undo a roles deploy from rollbackData.previous (written by deploy()): for each
 * entry, PATCH /api/v2/roles/{id} with the prior body and reconcile its permissions
 * back to the prior grants (restore), or — when the role was newly created
 * (priorRole null) — DELETE it (which also drops its permission grants). Applied
 * over the Auth0 Management API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; roleId: string | null; priorRole: RoleBody | null; priorPermissions: Auth0Permission[] }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 rollback' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    for (const { roleId, priorRole, priorPermissions } of previous) {
      if (!roleId) {
        skipped++
        continue
      }
      const path = `${base}/roles/${encodeURIComponent(roleId)}`
      if (priorRole) {
        await sendJson('PATCH', path, accessToken, priorRole)
        await reconcileRolePermissions(base, roleId, accessToken, priorPermissions ?? [])
        restored++
      } else {
        await deleteResource(path, accessToken)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back roles: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
