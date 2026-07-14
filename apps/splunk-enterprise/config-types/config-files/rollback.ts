import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkRequest, postForm } from '../../lib/splunkApi'

interface StanzaSnapshot {
  nsBase: string
  stanza: string
  existed: boolean
  prev: Record<string, string> | null
}

/**
 * Rollback config-file stanzas:
 *  - stanzas that existed before the deploy have their captured attributes restored
 *  - stanzas the deploy created are deleted
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, rollbackData } = ctx

  if (!credential || !connectivity) {
    return { success: false, message: 'Missing credential or connectivity for rollback' }
  }

  const snapshots = ((rollbackData as { stanzas?: StanzaSnapshot[] })?.stanzas) ?? []
  if (snapshots.length === 0) {
    return { success: false, message: 'No previous state available for config file rollback' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  let restored = 0
  let removed = 0

  try {
    // Reverse order so later writes are undone first.
    for (const snap of [...snapshots].reverse()) {
      const stanzaPath = `${snap.nsBase}/${encodeURIComponent(snap.stanza)}`
      if (!snap.existed) {
        await splunkRequest(`${baseUrl}${stanzaPath}`, { method: 'DELETE', headers: auth })
        removed += 1
      } else if (snap.prev && Object.keys(snap.prev).length > 0) {
        await postForm(baseUrl, auth, stanzaPath, snap.prev)
        restored += 1
      }
    }

    const actions: string[] = []
    if (restored > 0) actions.push(`restored ${restored} stanza(s)`)
    if (removed > 0) actions.push(`removed ${removed} created stanza(s)`)
    return { success: true, message: `Rollback complete: ${actions.join(', ') || 'no changes'}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
