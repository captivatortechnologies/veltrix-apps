import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, sendJson, coerceList, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import {
  resolveExplorerId,
  findExplorerById,
  buildPatchedSettings,
  declaresChange,
  text,
  type RunzeroExplorer,
  type RunzeroSiteLite,
  type ExplorerSettingsRollbackEntry,
} from './_shared'

/**
 * Deploy runZero Explorer Settings over the console REST API:
 *   read (identity): GET   /org/explorers   +   GET /org/sites   → resolve the explorer + target site
 *   update:          PATCH /org/explorers/{id}   with AgentPatchedSettings
 *
 * NO CREATE PATH: every item must reference an already-installed Explorer; an unresolved reference
 * surfaces as a 404 from the PATCH call. rollbackData records, per explorer, its resolved id and
 * its prior `site_id` only — `max_concurrent_scans` cannot be read back and so is never recorded
 * (see the WRITE-ONLY note in _shared.ts). Items that declare neither field are skipped entirely
 * (nothing to apply).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveRunzeroToken(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const timeoutMs = timeoutFrom(settings)

  const previous: ExplorerSettingsRollbackEntry[] = []
  const applied: string[] = []

  try {
    const explorers = coerceList<RunzeroExplorer>(await getJson<unknown>(`${base}/org/explorers`, headers, timeoutMs))
    const sites = coerceList<RunzeroSiteLite>(await getJson<unknown>(`${base}/org/sites`, headers, timeoutMs))

    for (const item of items) {
      const explorerRef = text(item.fields.explorer)
      if (!explorerRef || !declaresChange(item.fields)) continue

      const explorerId = resolveExplorerId(explorers, explorerRef)
      const priorSiteId = findExplorerById(explorers, explorerId)?.site_id ?? null
      const body = buildPatchedSettings(item.fields, sites)

      await sendJson('PATCH', `${base}/org/explorers/${encodeURIComponent(explorerId)}`, headers, body, timeoutMs)
      previous.push({ explorerRef, explorerId, priorSiteId })
      applied.push(explorerRef)
    }

    return {
      success: true,
      message: `Applied settings to ${applied.length} explorer(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Explorer settings deploy failed after ${applied.length} explorer(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

/** Resolve the per-request timeout (ms) from the app setting, defaulting to the client default. */
function timeoutFrom(settings: Record<string, unknown>): number | undefined {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined
}
