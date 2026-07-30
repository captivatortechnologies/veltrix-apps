import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'
import { parseEntries, serializeEntries, deriveFilename } from './_shared'

/**
 * Deploy Wazuh CDB lists over the REST API (55000):
 *   read (rollback): GET ${base}/lists/files/<filename>            (best-effort — 404 = new list)
 *   apply:           PUT ${base}/lists/files/<filename>?overwrite=true   (raw CDB body)
 *
 * The CDB file body is the canonical newline-separated `key:value` serialization
 * of the item's `entries`; `comment` is audit-only and never written to the file.
 *
 * rollbackData records the prior raw file body per filename (null when the file
 * did not exist) so rollback can PUT it back or DELETE the one we created.
 *
 * NOTE (verify against a live Wazuh 4.x manager): the /lists/files upload expects
 * the raw file as an octet-stream and `filename` is relative to etc/lists/; the
 * GET may return the body either raw or wrapped in a { data: { affected_items } }
 * envelope — captured verbatim here for a faithful rollback snapshot.
 */

/** Read the live CDB file body (best-effort) for the rollback snapshot; null on any miss. */
async function readList(base: string, headers: Record<string, string>, filename: string): Promise<string | null> {
  try {
    const res = await wazuhRequest(`${base}/lists/files/${encodeURIComponent(filename)}`, { headers })
    if (res.status === 404 || !res.ok) return null
    return res.body
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for CDB list deployment' }
  }

  const previous: Array<{ filename: string; content: string | null }> = []
  const applied: string[] = []

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    for (const item of items) {
      const filename = deriveFilename(item.fields.path, item.fields.listName)
      if (!filename) continue

      const existing = await readList(baseUrl, auth, filename)
      previous.push({ filename, content: existing })

      const body = serializeEntries(parseEntries(item.fields.entries).entries)
      const url = `${baseUrl}/lists/files/${encodeURIComponent(filename)}?overwrite=true`
      const res = await wazuhRequest(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', ...auth },
        body,
      })
      if (!res.ok) throw new Error(`PUT ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
      applied.push(filename)
    }

    return {
      success: true,
      message: `Applied ${applied.length} CDB list(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `CDB list deploy failed after ${applied.length} list(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
