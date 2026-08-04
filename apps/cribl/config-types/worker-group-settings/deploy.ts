import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, getJson, sendJson, groupResourcePath } from '../../lib/criblApi'
import { resolveWorkerGroup, itemsFromList } from '../../lib/criblCommon'
import { parseSettings, WORKER_GROUP_SETTINGS_RESOURCE } from './_shared'

/**
 * Deploy Worker Group Settings over the REST API:
 *   read (rollback snapshot): GET   /api/v1/m/<group>/system/settings/conf
 *   update:                   PATCH /api/v1/m/<group>/system/settings/conf   with the declared (partial) settings object
 *
 * There is no create/delete for this singleton — it always exists — so every
 * deploy is an update. rollbackData records the FULL prior settings object per
 * group (not just the declared subset) so rollback can restore an exact prior
 * state. See _shared.ts for the blast-radius warning.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for Worker Group Settings deployment' }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  const previous: Array<{ group: string; settings: Record<string, unknown> | null }> = []
  const applied: string[] = []

  try {
    const headers = await criblConnect(base, credential)

    for (const item of items) {
      const group = resolveWorkerGroup(item.fields, settings ?? {})
      const { settings: declared, error } = parseSettings(item.fields.settings)
      if (error || !declared) {
        return { success: false, message: `Worker Group Settings (${group || 'single-instance'}): ${error ?? 'invalid settings'}`, artifacts: { applied }, rollbackData: { previous } }
      }

      const url = groupResourcePath(base, group, WORKER_GROUP_SETTINGS_RESOURCE)
      let priorSettings: Record<string, unknown> | null = null
      try {
        const rows = itemsFromList<Record<string, unknown>>(await getJson<unknown>(url, headers))
        priorSettings = rows[0] ?? null
      } catch {
        priorSettings = null // best-effort snapshot; deploy still proceeds
      }

      await sendJson('PATCH', url, headers, declared)
      previous.push({ group, settings: priorSettings })
      applied.push(group || '(single-instance)')
    }

    return {
      success: true,
      message: `Applied Worker Group Settings for ${applied.length} group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Worker Group Settings deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
