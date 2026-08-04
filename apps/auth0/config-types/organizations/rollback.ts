import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, sendJson, deleteResource } from '../../lib/auth0Api'
import { reconcileEnabledConnections } from './connections'
import type { EnabledConnectionSpec, OrganizationUpdateBody } from './_shared'

/**
 * Undo an organizations deploy from rollbackData.previous (written by deploy()):
 * for each entry, restore the prior enabled connections, then either PATCH
 * /api/v2/organizations/{id} with the prior managed body (restore), or — when the
 * organization was newly created (prior null) — DELETE it. Applied over the
 * Auth0 Management API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{
      name: string
      orgId: string | null
      priorOrg: OrganizationUpdateBody | null
      priorConnections: EnabledConnectionSpec[]
    }>
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

    for (const { orgId, priorOrg, priorConnections } of previous) {
      if (!orgId) {
        skipped++
        continue
      }
      const path = `${base}/organizations/${encodeURIComponent(orgId)}`
      if (priorOrg) {
        await reconcileEnabledConnections(base, orgId, accessToken, priorConnections)
        await sendJson('PATCH', path, accessToken, priorOrg)
        restored++
      } else {
        await deleteResource(path, accessToken)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back organizations: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
