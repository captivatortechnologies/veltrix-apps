import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { buildGalaxyFields, galaxiesFromList, findGalaxy, normalizeYesNo, type MispGalaxy } from './_shared'

/**
 * Deploy custom MISP galaxies over the REST API (443):
 *   read (rollback): GET  /galaxies                → find the live galaxy by type
 *   create:          POST /galaxies/add             with { Galaxy: {...} }
 *   update:          POST /galaxies/edit/<id>        with { Galaxy: {...} } (galaxy exists)
 *   state:           POST /galaxies/enable/<id> | /galaxies/disable/<id>  (always applied
 *                    after create/update — the dedicated toggle endpoint is the verified
 *                    way to set `enabled`; whether add/edit's own body honors it is not)
 *
 * The `type` is the stable identity used to upsert. A galaxy whose live match is
 * MISP's own default galaxy (`default: true`) is skipped — this type never edits
 * the library MISP ships. rollbackData records, per galaxy, the prior galaxy body
 * (null when it did not exist) AND the galaxy id — a prior body restores via edit +
 * a re-applied prior enabled state; a newly created galaxy (no prior body) is
 * deleted on rollback via /galaxies/delete/<id>.
 *
 * NOTE: verify /galaxies + /galaxies/add + /galaxies/edit/<id> +
 * /galaxies/enable|disable/<id> + /galaxies/delete/<id> against a live MISP 2.4 instance.
 */
interface GalaxyMutationResponse {
  Galaxy?: MispGalaxy
}

async function listGalaxies(base: string, headers: Record<string, string>): Promise<MispGalaxy[]> {
  try {
    return galaxiesFromList(await getJson<unknown>(`${base}/galaxies`, headers))
  } catch {
    return []
  }
}

async function setEnabled(base: string, headers: Record<string, string>, id: number | string, enabled: boolean): Promise<void> {
  await sendJson('POST', `${base}/galaxies/${enabled ? 'enable' : 'disable'}/${encodeURIComponent(String(id))}`, headers, {})
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for galaxy deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ type: string; galaxyId: number | string | null; galaxy: MispGalaxy | null; enabledBefore: boolean | null }> = []
  const applied: string[] = []
  const skippedDefault: string[] = []

  try {
    const live = await listGalaxies(base, headers)

    for (const item of items) {
      const type = String(item.fields.type ?? '').trim()
      if (!type) continue

      const existing = findGalaxy(live, type)
      const rawMatch = live.find((g) => String(g.type ?? '').trim().toLowerCase() === type.toLowerCase())
      if (rawMatch && normalizeYesNo(rawMatch.default)) {
        skippedDefault.push(type) // never touch MISP's own default galaxy library
        continue
      }

      const desiredEnabled = normalizeYesNo(item.fields.enabled)
      const body = { Galaxy: buildGalaxyFields(item.fields) }

      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/galaxies/edit/${encodeURIComponent(String(existing.id))}`, headers, body)
        await setEnabled(base, headers, existing.id, desiredEnabled)
        previous.push({ type, galaxyId: existing.id, galaxy: existing, enabledBefore: normalizeYesNo(existing.enabled) })
      } else {
        const created = await sendJson<GalaxyMutationResponse>('POST', `${base}/galaxies/add`, headers, body)
        const newId = created?.Galaxy?.id ?? null
        if (newId != null) await setEnabled(base, headers, newId, desiredEnabled)
        previous.push({ type, galaxyId: newId, galaxy: null, enabledBefore: null })
      }
      applied.push(type)
    }

    const skipNote = skippedDefault.length ? ` (skipped ${skippedDefault.length} default galaxy(ies): ${skippedDefault.join(', ')})` : ''
    return {
      success: true,
      message: `Applied ${applied.length} galaxy(ies): ${applied.join(', ') || '(none)'}${skipNote}`,
      artifacts: { applied, skippedDefault },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Galaxy deploy failed after ${applied.length} galaxy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, skippedDefault },
      rollbackData: { previous },
    }
  }
}
