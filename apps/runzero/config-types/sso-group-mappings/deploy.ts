import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, sendJson, coerceList, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import {
  buildMapping,
  buildMappingUpdate,
  resolveGroupId,
  findMapping,
  text,
  type RunzeroGroupMapping,
  type RunzeroGroupLite,
  type SsoGroupMappingRollbackEntry,
} from './_shared'

/**
 * Deploy runZero SSO Group Mappings over the console REST API:
 *   read (identity): GET  /account/groups     +  GET /account/sso/groups   → resolve group + match a mapping
 *   create:          POST /account/sso/groups  with GroupMapping (no id)
 *   update:          PUT  /account/sso/groups  with GroupMapping (full object, id inside — mapping exists)
 *
 * ACCOUNT-scoped: requires an account-scoped runZero API key (see _shared header). The
 * (sso_attribute, sso_value) pair is the stable identity used to upsert. rollbackData records, per
 * mapping, whether it already existed, its id, and its prior body — so rollback can restore an
 * update or delete a create.
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

  const previous: SsoGroupMappingRollbackEntry[] = []
  const applied: string[] = []

  try {
    const groups = coerceList<RunzeroGroupLite>(await getJson<unknown>(`${base}/account/groups`, headers, timeoutMs))
    const mappings = coerceList<RunzeroGroupMapping>(await getJson<unknown>(`${base}/account/sso/groups`, headers, timeoutMs))

    for (const item of items) {
      const ssoAttribute = text(item.fields.ssoAttribute)
      const ssoValue = text(item.fields.ssoValue)
      if (!ssoAttribute || !ssoValue) continue

      const groupId = resolveGroupId(groups, item.fields.group)
      const existing = findMapping(mappings, ssoAttribute, ssoValue)

      if (existing && existing.id) {
        await sendJson('PUT', `${base}/account/sso/groups`, headers, buildMappingUpdate(existing.id, item.fields, groupId), timeoutMs)
        previous.push({ ssoAttribute, ssoValue, mappingId: existing.id, existed: true, prior: existing })
      } else {
        const created = await sendJson<RunzeroGroupMapping>('POST', `${base}/account/sso/groups`, headers, buildMapping(item.fields, groupId), timeoutMs)
        previous.push({ ssoAttribute, ssoValue, mappingId: created?.id ?? null, existed: false, prior: null })
      }
      applied.push(`${ssoAttribute}=${ssoValue}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} SSO group mapping(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `SSO group mapping deploy failed after ${applied.length} mapping(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
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
