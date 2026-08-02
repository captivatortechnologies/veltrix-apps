import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, sendJson, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import { buildSiteOptions, sitesFromList, findSite, type RunzeroSite, type SiteRollbackEntry } from './_shared'

/**
 * Deploy runZero Sites over the console REST API:
 *   read (rollback): GET   /org/sites            → find the live site by name
 *   create:          PUT   /org/sites            with SiteOptions { name, description, scope }
 *   update:          PATCH /org/sites/{id}        with SiteOptions (site exists)
 *
 * NOTE: runZero CREATES a site with PUT (not POST) — createSite is `PUT /org/sites`
 * in the OpenAPI spec — and UPDATES with PATCH /org/sites/{id}.
 *
 * The name is the stable identity used to upsert. rollbackData records, per site,
 * whether it already existed, its id, and its prior body — so rollback can restore
 * an updated site or delete a newly created one.
 */
async function listSites(base: string, headers: Record<string, string>, timeoutMs?: number): Promise<RunzeroSite[]> {
  return sitesFromList(await getJson<unknown>(`${base}/org/sites`, headers, timeoutMs))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveRunzeroToken(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const timeoutMs = timeoutFrom(settings)

  const previous: SiteRollbackEntry[] = []
  const applied: string[] = []

  try {
    const live = await listSites(base, headers, timeoutMs)

    for (const item of items) {
      const options = buildSiteOptions(item.fields)
      if (!options.name) continue

      const existing = findSite(live, options.name)

      if (existing && existing.id) {
        await sendJson('PATCH', `${base}/org/sites/${encodeURIComponent(existing.id)}`, headers, options, timeoutMs)
        previous.push({ name: options.name, siteId: existing.id, existed: true, prior: existing })
      } else {
        const created = await sendJson<RunzeroSite>('PUT', `${base}/org/sites`, headers, options, timeoutMs)
        previous.push({ name: options.name, siteId: created?.id ?? null, existed: false, prior: null })
      }
      applied.push(options.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} site(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Site deploy failed after ${applied.length} site(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
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
