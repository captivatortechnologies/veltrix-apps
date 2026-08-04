import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  sendJson,
  deleteResource,
} from '../../lib/auth0Api'
import type { LogStreamUpdateBody } from './_shared'

/**
 * Undo a log-streams deploy from rollbackData.previous (written by deploy()):
 * for each entry, PATCH /api/v2/log-streams/{id} with the prior managed body
 * (restore), or — when the stream was newly created (prior null) — DELETE it.
 * Applied over the Auth0 Management API v2. Secret sink keys were stripped
 * from the snapshot, so a restore never overwrites a live secret with its mask.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; logStreamId: string | null; prior: LogStreamUpdateBody | null }>
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

    for (const { logStreamId, prior } of previous) {
      if (!logStreamId) {
        skipped++
        continue
      }
      const path = `${base}/log-streams/${encodeURIComponent(logStreamId)}`
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
      message: `Rolled back log streams: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
