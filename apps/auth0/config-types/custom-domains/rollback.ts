import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  sendJson,
  deleteResource,
} from '../../lib/auth0Api'
import type { CustomDomainUpdateBody } from './_shared'

/**
 * Undo a custom-domains deploy from rollbackData.previous (written by
 * deploy()): for each entry, PATCH /api/v2/custom-domains/{id} with the prior
 * managed body (restore), or — when the domain was newly created (prior null)
 * — DELETE it. Applied over the Auth0 Management API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ domain: string; customDomainId: string | null; prior: CustomDomainUpdateBody | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 rollback' }
  }

  const domainHost = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domainHost)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    const { accessToken } = await fetchManagementToken({ domain: domainHost, clientId: creds.clientId, clientSecret: creds.clientSecret })

    for (const { customDomainId, prior } of previous) {
      if (!customDomainId) {
        skipped++
        continue
      }
      const path = `${base}/custom-domains/${encodeURIComponent(customDomainId)}`
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
      message: `Rolled back custom domains: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
