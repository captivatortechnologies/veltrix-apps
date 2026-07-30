// NOTE: verify against a live Wazuh 4.x manager; XML bodies + restart are assumed.
import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'

/**
 * Deploy Wazuh custom decoder files over the REST API (55000):
 *   read (rollback): GET ${base}/decoders/files/<filename>                (best-effort — 404 = new file)
 *   apply:           PUT ${base}/decoders/files/<filename>?overwrite=true  (raw decoders XML)
 *   reload:          PUT ${base}/manager/restart                           (best-effort — a decoder change needs a restart to take effect)
 *
 * `comment` is audit-only and is never written to the file body. rollbackData
 * records the prior raw body per filename (null when the file did not exist) so
 * rollback can PUT it back or DELETE the one we created. The restart is issued
 * once after all files land, is best-effort, and is surfaced in the result
 * message rather than failing the deploy on its own.
 */

/** Read the live decoders file body (best-effort) for the rollback snapshot; null on any miss. */
async function readFile(base: string, headers: Record<string, string>, filename: string): Promise<string | null> {
  try {
    const res = await wazuhRequest(`${base}/decoders/files/${encodeURIComponent(filename)}`, { headers })
    if (res.status === 404 || !res.ok) return null
    return res.body
  } catch {
    return null
  }
}

/** Best-effort manager restart to reload the decoder set; never throws — the outcome is reported. */
async function requestRestart(base: string, headers: Record<string, string>): Promise<string> {
  try {
    const res = await wazuhRequest(`${base}/manager/restart`, { method: 'PUT', headers })
    return res.ok ? `requested (HTTP ${res.status})` : `not confirmed (HTTP ${res.status})`
  } catch (error) {
    return `failed (${error instanceof Error ? error.message : 'error'})`
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for custom-decoders deployment' }
  }

  const previous: Array<{ filename: string; content: string | null }> = []
  const applied: string[] = []

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    for (const item of items) {
      const filename = String(item.fields.filename ?? '').trim()
      if (!filename) continue

      const existing = await readFile(baseUrl, auth, filename)
      previous.push({ filename, content: existing })

      const body = String(item.fields.decodersXml ?? '')
      const url = `${baseUrl}/decoders/files/${encodeURIComponent(filename)}?overwrite=true`
      const res = await wazuhRequest(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/xml', ...auth },
        body,
      })
      if (!res.ok) throw new Error(`PUT ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
      applied.push(filename)
    }

    const restart = applied.length ? await requestRestart(baseUrl, auth) : 'skipped (no files applied)'

    return {
      success: true,
      message: `Applied ${applied.length} decoders file(s): ${applied.join(', ') || '(none)'}. Manager restart: ${restart}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom-decoders deploy failed after ${applied.length} file(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
