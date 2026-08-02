import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, sendJson, coerceList, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import {
  buildTemplateOptions,
  buildTemplateUpdate,
  findTemplate,
  orgIdFrom,
  text,
  type RunzeroScanTemplate,
  type ScanTemplateRollbackEntry,
} from './_shared'

/**
 * Deploy runZero Scan Templates over the console REST API:
 *   read (identity): GET  /org (org id) + GET /account/tasks/templates → find template by name
 *   create:          POST /account/tasks/templates            with ScanTemplateOptions
 *   update:          PUT  /account/tasks/templates            with the full ScanTemplate (id inside)
 *
 * ACCOUNT-scoped: requires an account-scoped runZero API key (see _shared header). The template
 * name is the stable identity used to upsert. rollbackData records, per template, whether it
 * existed, its id, and its prior body — so rollback can restore an update or delete a create.
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

  const previous: ScanTemplateRollbackEntry[] = []
  const applied: string[] = []

  try {
    const resolvedOrgId = orgIdFrom(await getJson<unknown>(`${base}/org`, headers, timeoutMs).catch(() => null))
    const templates = coerceList<RunzeroScanTemplate>(await getJson<unknown>(`${base}/account/tasks/templates`, headers, timeoutMs))

    for (const item of items) {
      const name = text(item.fields.name)
      if (!name) continue

      const existing = findTemplate(templates, name)

      if (existing && existing.id) {
        await sendJson('PUT', `${base}/account/tasks/templates`, headers, buildTemplateUpdate(existing, item.fields, resolvedOrgId), timeoutMs)
        previous.push({ name, templateId: existing.id, existed: true, prior: existing })
      } else {
        const created = await sendJson<RunzeroScanTemplate>(
          'POST',
          `${base}/account/tasks/templates`,
          headers,
          buildTemplateOptions(item.fields, resolvedOrgId),
          timeoutMs,
        )
        previous.push({ name, templateId: created?.id ?? null, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} scan template(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scan template deploy failed after ${applied.length} template(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
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
