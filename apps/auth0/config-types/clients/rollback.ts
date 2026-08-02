import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  sendJson,
  deleteResource,
} from '../../lib/auth0Api'
import type { Auth0ClientBody } from './_shared'

/**
 * Undo a clients deploy from rollbackData.previous (written by deploy()): for
 * each entry, PATCH /api/v2/clients/{id} with the prior managed body (restore),
 * or — when the client was newly created (prior null) — DELETE /api/v2/clients/{id}
 * to remove it. Applied over the Auth0 Management API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; clientId: string | null; prior: Auth0ClientBody | null }>
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

    for (const { clientId, prior } of previous) {
      if (!clientId) {
        // A created client whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/clients/${encodeURIComponent(clientId)}`
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
      message: `Rolled back applications: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
