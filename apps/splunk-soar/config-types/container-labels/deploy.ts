import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, getJson, sendJson } from '../../lib/soarApi'
import { buildLabelName, parseLabelList } from './_shared'

/**
 * Ensure every declared container label exists over the SOAR REST API (443):
 *   read : GET  /rest/system_settings/labels
 *   add  : POST /rest/system_settings/events { add_label: true, label_name }
 *
 * A label already present in SOAR is left untouched (there is no rename or
 * other per-label edit). rollbackData records only the labels THIS deploy
 * newly added — a label that already existed is never removed by rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for container label deployment' }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  const added: string[] = []
  const alreadyPresent: string[] = []

  try {
    const live = new Set(parseLabelList(await getJson<unknown>(`${base}/rest/system_settings/labels`, headers)).map((l) => l.toLowerCase()))

    for (const item of items) {
      const name = buildLabelName(item.fields)
      if (!name) continue

      if (live.has(name.toLowerCase())) {
        alreadyPresent.push(name)
        continue
      }
      await sendJson('POST', `${base}/rest/system_settings/events`, headers, { add_label: true, label_name: name })
      added.push(name)
      live.add(name.toLowerCase())
    }

    return {
      success: true,
      message: `Ensured ${added.length + alreadyPresent.length} label(s): ${added.length} added, ${alreadyPresent.length} already present.`,
      artifacts: { added, alreadyPresent },
      rollbackData: { added },
    }
  } catch (error) {
    return {
      success: false,
      message: `Container label deploy failed after adding ${added.length} label(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { added, alreadyPresent },
      rollbackData: { added },
    }
  }
}
