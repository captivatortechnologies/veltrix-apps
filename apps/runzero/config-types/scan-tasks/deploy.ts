import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, sendJson, coerceList, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import {
  buildScanOptions,
  buildTaskUpdate,
  resolveSiteId,
  findRecurringTask,
  normalizeFrequency,
  text,
  type RunzeroTask,
  type RunzeroSiteLite,
  type ScanTaskRollbackEntry,
} from './_shared'

/**
 * Deploy runZero Scan Tasks over the console REST API:
 *   read (identity): GET   /org/sites   +   GET /org/tasks   → resolve site + match a recurring task
 *   create:          PUT   /org/sites/{site_id}/scan   with ScanOptions (targets required)
 *   update:          PATCH /org/tasks/{task_id}         with TaskOptions (existing recurring task)
 *
 * (site, scan-name) is the stable identity used to upsert a recurring schedule. A `once`
 * frequency has no recurring task to match, so it always creates a fresh one-time scan.
 * rollbackData records, per task, whether it already existed, its id, whether it recurs,
 * and its prior body — so rollback can stop a newly-created schedule or restore an updated one.
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

  const previous: ScanTaskRollbackEntry[] = []
  const applied: string[] = []

  try {
    const sites = coerceList<RunzeroSiteLite>(await getJson<unknown>(`${base}/org/sites`, headers, timeoutMs))
    const tasks = coerceList<RunzeroTask>(await getJson<unknown>(`${base}/org/tasks`, headers, timeoutMs))

    for (const item of items) {
      const options = buildScanOptions(item.fields)
      const name = options['scan-name']
      const siteRef = text(item.fields.site)
      if (!name || !siteRef) continue

      const siteId = resolveSiteId(sites, siteRef)
      const existing = findRecurringTask(tasks, siteId, name)

      if (existing && existing.id) {
        await sendJson('PATCH', `${base}/org/tasks/${encodeURIComponent(existing.id)}`, headers, buildTaskUpdate(existing, item.fields), timeoutMs)
        previous.push({ name, site: siteRef, taskId: existing.id, existed: true, recurring: true, prior: existing })
      } else {
        const created = await sendJson<RunzeroTask>('PUT', `${base}/org/sites/${encodeURIComponent(siteId)}/scan`, headers, options, timeoutMs)
        previous.push({
          name,
          site: siteRef,
          taskId: created?.id ?? null,
          existed: false,
          recurring: normalizeFrequency(item.fields.frequency) !== 'once',
          prior: null,
        })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} scan task(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scan task deploy failed after ${applied.length} task(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
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
