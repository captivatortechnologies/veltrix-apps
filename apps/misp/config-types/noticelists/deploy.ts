import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { noticelistsFromList, findNoticelist, normalizeEnabled, type MispNoticelist } from './_shared'

/**
 * Deploy MISP noticelist states over the REST API (443):
 *   read (rollback): GET  /noticelists              → find the live noticelist by name
 *   enable:          POST /noticelists/enableNoticelist/<id>/true
 *   disable:         POST /noticelists/enableNoticelist/<id>       (no trailing segment)
 *
 * The enable/disable route shape (a trailing `/true` segment to enable, no
 * segment to disable) mirrors PyMISP's own `enable_noticelist`/`disable_noticelist`
 * exactly (see MISP/PyMISP#4856 for the route's history). The name is the stable
 * identity. Noticelists ship with MISP, so a name that isn't present is skipped
 * (this type cannot create one over this seam). rollbackData records, per
 * noticelist, the id and its prior enabled state so rollback can restore it.
 *
 * NOTE: verify /noticelists + /noticelists/enableNoticelist/<id>[/true] against a
 * live MISP 2.4 instance.
 */
async function listNoticelists(base: string, headers: Record<string, string>): Promise<MispNoticelist[]> {
  try {
    return noticelistsFromList(await getJson<unknown>(`${base}/noticelists`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for noticelist deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; noticelistId: number | string; enabledBefore: boolean }> = []
  const applied: string[] = []
  const skipped: string[] = []

  try {
    const live = await listNoticelists(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findNoticelist(live, name)
      if (!existing || existing.id == null) {
        skipped.push(name)
        continue
      }

      const desired = normalizeEnabled(item.fields.state)
      const enabledBefore = normalizeEnabled(existing.enabled)
      const path = desired
        ? `${base}/noticelists/enableNoticelist/${encodeURIComponent(String(existing.id))}/true`
        : `${base}/noticelists/enableNoticelist/${encodeURIComponent(String(existing.id))}`
      await sendJson('POST', path, headers, {})
      previous.push({ name, noticelistId: existing.id, enabledBefore })
      applied.push(name)
    }

    const skipNote = skipped.length ? ` (skipped ${skipped.length} not present in MISP: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Applied ${applied.length} noticelist state(s): ${applied.join(', ') || '(none)'}${skipNote}`,
      artifacts: { applied, skipped },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Noticelist deploy failed after ${applied.length} noticelist(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, skipped },
      rollbackData: { previous },
    }
  }
}
