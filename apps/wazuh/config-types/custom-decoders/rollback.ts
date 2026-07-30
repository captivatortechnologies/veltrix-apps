import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'

/**
 * Undo a custom-decoders deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT the prior raw file body back, or DELETE the file we created
 * (its prior body was null). Applied over the Wazuh REST API (55000). A manager
 * restart to re-activate the prior decoder set is deferred to the operator.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ filename: string; content: string | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for custom-decoders rollback' }
  }

  let restored = 0
  let deleted = 0
  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    for (const { filename, content } of previous) {
      if (content != null) {
        const url = `${baseUrl}/decoders/files/${encodeURIComponent(filename)}?overwrite=true`
        const res = await wazuhRequest(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/xml', ...auth },
          body: content,
        })
        if (!res.ok) throw new Error(`PUT ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        restored++
      } else {
        const url = `${baseUrl}/decoders/files/${encodeURIComponent(filename)}`
        const res = await wazuhRequest(url, { method: 'DELETE', headers: auth })
        if (!res.ok && res.status !== 404) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        deleted++
      }
    }
    return { success: true, message: `Rolled back decoders files: ${restored} restored, ${deleted} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
