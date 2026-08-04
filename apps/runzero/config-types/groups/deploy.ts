import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, sendJson, coerceList, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import { buildGroupPost, buildGroupPut, findGroup, text, type RunzeroGroup, type GroupRollbackEntry } from './_shared'

/**
 * Deploy runZero Groups over the console REST API:
 *   read (identity): GET /account/groups   → find the live group by name
 *   create:          POST /account/groups  with GroupPost
 *   update:          PUT  /account/groups  with GroupPut (full object, id inside — group exists)
 *
 * ACCOUNT-scoped: requires an account-scoped runZero API key (see _shared header). The name is the
 * stable identity used to upsert. rollbackData records, per group, whether it already existed, its
 * id, and its prior body — so rollback can restore an update or delete a create.
 *
 * WARNING: rollback of a create DELETEs the group. See _shared header and the app README.
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

  const previous: GroupRollbackEntry[] = []
  const applied: string[] = []

  try {
    const live = coerceList<RunzeroGroup>(await getJson<unknown>(`${base}/account/groups`, headers, timeoutMs))

    for (const item of items) {
      const name = text(item.fields.name)
      if (!name) continue

      const existing = findGroup(live, name)

      if (existing && existing.id) {
        await sendJson('PUT', `${base}/account/groups`, headers, buildGroupPut(existing.id, item.fields), timeoutMs)
        previous.push({ name, groupId: existing.id, existed: true, prior: existing })
      } else {
        const created = await sendJson<RunzeroGroup>('POST', `${base}/account/groups`, headers, buildGroupPost(item.fields), timeoutMs)
        previous.push({ name, groupId: created?.id ?? null, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
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
