import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  sendJson,
  deleteResource,
} from '../../lib/auth0Api'
import type { ResourceServerUpdateBody } from './_shared'

/**
 * Undo a resource-servers deploy from rollbackData.previous (written by deploy()):
 * for each entry, PATCH /api/v2/resource-servers/{id} with the prior managed body
 * (restore), or — when the API was newly created (prior null) — DELETE it. Applied
 * over the Auth0 Management API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; resourceServerId: string | null; prior: ResourceServerUpdateBody | null }>
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

    for (const { resourceServerId, prior } of previous) {
      if (!resourceServerId) {
        skipped++
        continue
      }
      const path = `${base}/resource-servers/${encodeURIComponent(resourceServerId)}`
      if (prior) {
        await sendJson('PATCH', path, accessToken, prior)
        restored++
      } else {
        await deleteResource(path, accessToken)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back APIs: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
