import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { taxonomiesFromList, findTaxonomy, normalizeEnabled, type MispTaxonomy } from './_shared'

/**
 * Deploy MISP taxonomy states over the REST API (443):
 *   read (rollback): GET  /taxonomies              → find the live taxonomy by namespace
 *   enable:          POST /taxonomies/enable/<id>
 *   disable:         POST /taxonomies/disable/<id>
 *
 * The namespace is the stable identity. Taxonomies are loaded from MISP's taxonomy
 * library, so a namespace that isn't present is skipped (this type cannot create
 * one over this seam). rollbackData records, per taxonomy, the id and its prior
 * enabled state so rollback can restore it.
 *
 * NOTE: verify /taxonomies + /taxonomies/enable|disable/<id> against a live MISP 2.4 instance.
 */
async function listTaxonomies(base: string, headers: Record<string, string>): Promise<MispTaxonomy[]> {
  try {
    return taxonomiesFromList(await getJson<unknown>(`${base}/taxonomies`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for taxonomy deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ namespace: string; taxonomyId: number | string; enabledBefore: boolean }> = []
  const applied: string[] = []
  const skipped: string[] = []

  try {
    const live = await listTaxonomies(base, headers)

    for (const item of items) {
      const namespace = String(item.fields.namespace ?? '').trim()
      if (!namespace) continue

      const existing = findTaxonomy(live, namespace)
      if (!existing || existing.id == null) {
        skipped.push(namespace)
        continue
      }

      const desired = normalizeEnabled(item.fields.state)
      const enabledBefore = normalizeEnabled(existing.enabled)
      const verb = desired ? 'enable' : 'disable'
      await sendJson('POST', `${base}/taxonomies/${verb}/${encodeURIComponent(String(existing.id))}`, headers, {})
      previous.push({ namespace, taxonomyId: existing.id, enabledBefore })
      applied.push(namespace)
    }

    const skipNote = skipped.length ? ` (skipped ${skipped.length} not present in MISP: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Applied ${applied.length} taxonomy state(s): ${applied.join(', ') || '(none)'}${skipNote}`,
      artifacts: { applied, skipped },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Taxonomy deploy failed after ${applied.length} taxonomy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, skipped },
      rollbackData: { previous },
    }
  }
}
