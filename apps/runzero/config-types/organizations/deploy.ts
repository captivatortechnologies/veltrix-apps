import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, sendJson, coerceList, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import { buildOrgOptions, findOrg, text, type RunzeroOrganization, type OrgRollbackEntry } from './_shared'

/**
 * Deploy runZero Organizations over the console REST API:
 *   read (identity): GET   /account/orgs   → find the live organization by name
 *   create:          PUT   /account/orgs   with OrgOptions
 *   update:          PATCH /account/orgs/{id}   with OrgOptions (organization exists)
 *
 * ACCOUNT-scoped: requires an account-scoped runZero API key (see _shared header). The name is the
 * stable identity used to upsert. rollbackData records, per organization, whether it already
 * existed, its id, and its prior body — so rollback can restore an update or delete a create.
 *
 * WARNING: rollback of a create DELETEs the organization, cascading to everything created under it
 * since. See _shared header and the app README.
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

  const previous: OrgRollbackEntry[] = []
  const applied: string[] = []

  try {
    const live = coerceList<RunzeroOrganization>(await getJson<unknown>(`${base}/account/orgs`, headers, timeoutMs))

    for (const item of items) {
      const options = buildOrgOptions(item.fields)
      const name = text(options.name)
      if (!name) continue

      const existing = findOrg(live, name)

      if (existing && existing.id) {
        await sendJson('PATCH', `${base}/account/orgs/${encodeURIComponent(existing.id)}`, headers, options, timeoutMs)
        previous.push({ name, orgId: existing.id, existed: true, prior: existing })
      } else {
        const created = await sendJson<RunzeroOrganization>('PUT', `${base}/account/orgs`, headers, options, timeoutMs)
        previous.push({ name, orgId: created?.id ?? null, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} organization(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Organization deploy failed after ${applied.length} organization(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
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
