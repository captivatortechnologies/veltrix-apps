import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { warninglistsFromList, findWarninglist, normalizeEnabled, type MispWarninglist } from './_shared'

/**
 * Deploy MISP warninglist states over the REST API (443):
 *   read (rollback): GET  /warninglists            → find the live warninglist by name
 *   toggle:          POST /warninglists/toggleEnable with { id, enabled: true|false }
 *
 * The name is the stable identity. Warninglists ship with MISP, so a name that
 * isn't present is skipped (this type cannot create one over this seam).
 * rollbackData records, per warninglist, the id and its prior enabled state so
 * rollback can restore it.
 *
 * NOTE: verify /warninglists + /warninglists/toggleEnable against a live MISP 2.4 instance.
 */
async function listWarninglists(base: string, headers: Record<string, string>): Promise<MispWarninglist[]> {
  try {
    return warninglistsFromList(await getJson<unknown>(`${base}/warninglists`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for warninglist deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; warninglistId: number | string; enabledBefore: boolean }> = []
  const applied: string[] = []
  const skipped: string[] = []

  try {
    const live = await listWarninglists(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findWarninglist(live, name)
      if (!existing || existing.id == null) {
        skipped.push(name)
        continue
      }

      const desired = normalizeEnabled(item.fields.state)
      const enabledBefore = normalizeEnabled(existing.enabled)
      await sendJson('POST', `${base}/warninglists/toggleEnable`, headers, { id: existing.id, enabled: desired })
      previous.push({ name, warninglistId: existing.id, enabledBefore })
      applied.push(name)
    }

    const skipNote = skipped.length ? ` (skipped ${skipped.length} not present in MISP: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Applied ${applied.length} warninglist state(s): ${applied.join(', ') || '(none)'}${skipNote}`,
      artifacts: { applied, skipped },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Warninglist deploy failed after ${applied.length} warninglist(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, skipped },
      rollbackData: { previous },
    }
  }
}
