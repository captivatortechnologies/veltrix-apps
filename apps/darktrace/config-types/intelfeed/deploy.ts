import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDarktraceUrl, darktraceAuthFrom, dtGetJson, dtPostJson, type DarktraceAuth } from '../../lib/darktraceApi'
import { buildAddBody, entriesFromList, findEntry, normalizeEntry, type IntelfeedEntry } from './_shared'

/**
 * Deploy Darktrace intel-feed watched entries over the REST API (443, DSA-signed):
 *   read (identity + rollback): GET  /intelfeed?fulldetails=true  → live entries
 *   add:                        POST /intelfeed { addentry, source, ... }
 *
 * The entry name is the stable identity. Darktrace's intel feed is append/remove
 * only (no edit), so this UPSERTS idempotently: an entry already watched is left
 * untouched (and NOT claimed for rollback); a new entry is added and recorded in
 * rollbackData.created so rollback can remove exactly what this deploy created.
 *
 * NOTE: entry metadata (source/description/expiry) on an ALREADY-watched entry is
 * not rewritten — Darktrace exposes no edit over this seam. Verify against a live
 * Darktrace.
 */

/** Read every live watched entry (best-effort) for identity matching + rollback. */
async function listEntries(base: string, auth: DarktraceAuth): Promise<IntelfeedEntry[]> {
  try {
    return entriesFromList(await dtGetJson<unknown>(base, '/intelfeed', { fulldetails: true }, auth))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const auth = darktraceAuthFrom(credential)
  if (!auth) {
    return { success: false, message: 'Missing Darktrace API token pair (public + private) for intel-feed deployment' }
  }

  const base = buildDarktraceUrl(component, connectivity, connectivityProvider)

  const created: Array<{ entry: string; source: string }> = []
  const applied: string[] = []
  let skipped = 0

  try {
    const live = await listEntries(base, auth)

    for (const item of items) {
      const entry = normalizeEntry(item.fields.entry)
      if (!entry) continue

      if (findEntry(live, entry)) {
        skipped++ // already watched — idempotent no-op, not ours to roll back
        continue
      }

      await dtPostJson(base, '/intelfeed', buildAddBody(item.fields), auth)
      created.push({ entry, source: String(item.fields.source ?? '').trim() })
      applied.push(entry)
    }

    const summary = applied.length
      ? `Added ${applied.length} watched entr${applied.length === 1 ? 'y' : 'ies'}: ${applied.join(', ')}`
      : 'No new watched entries to add (all already present).'
    return {
      success: true,
      message: skipped ? `${summary} (${skipped} already watched)` : summary,
      artifacts: { applied, skipped },
      rollbackData: { created },
    }
  } catch (error) {
    return {
      success: false,
      message: `Intel-feed deploy failed after ${applied.length} entr${applied.length === 1 ? 'y' : 'ies'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { created },
    }
  }
}
