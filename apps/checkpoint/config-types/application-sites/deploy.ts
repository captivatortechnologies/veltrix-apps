import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCheckpointClient,
  checkpointErrorMessage,
  isNotFoundError,
  MAX_PAGE_SIZE,
  type CheckpointClient,
} from '../../lib/checkpointApi'
import { liveTagNames } from '../lib/checkpointShared'
import {
  applicationSiteKey,
  extractApplicationSiteSpecs,
  livePrimaryCategoryName,
  type ApplicationSiteSpec,
  type LiveApplicationSite,
} from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the site existed before THIS deploy — set-application-site (true) vs add-application-site (false). */
  existed: boolean
  prior?: Record<string, unknown>
}

/** Build the add-application-site / set-application-site request body for a declared spec. */
export function buildApplicationSiteBody(spec: ApplicationSiteSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    'url-list': spec.urlList,
    'urls-defined-as-regular-expression': spec.urlsDefinedAsRegex,
  }
  if (spec.primaryCategory) body['primary-category'] = spec.primaryCategory
  if (spec.description) body.description = spec.description
  if (spec.comments) body.comments = spec.comments
  if (spec.color) body.color = spec.color
  if (spec.tags.length > 0) body.tags = spec.tags
  return body
}

/** Snapshot a live application site's managed fields into a set-compatible body, for rollback. */
export function snapshotLive(live: LiveApplicationSite): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: live.name,
    'url-list': Array.isArray(live['url-list']) ? live['url-list'] : [],
    'urls-defined-as-regular-expression': live['urls-defined-as-regular-expression'] ?? false,
  }
  const category = livePrimaryCategoryName(live['primary-category'])
  if (category) body['primary-category'] = category
  if (live.description) body.description = live.description
  if (live.comments) body.comments = live.comments
  if (live.color) body.color = live.color
  const tags = liveTagNames(live.tags)
  if (tags.length > 0) body.tags = tags
  return body
}

/** Page through show-application-sites (max 500/page) and return every custom app in the domain. */
export async function listAllApplicationSites(client: CheckpointClient): Promise<LiveApplicationSite[]> {
  const sites: LiveApplicationSite[] = []
  let offset = 0
  for (;;) {
    const res = await client.call<{ objects?: LiveApplicationSite[]; total?: number }>('show-application-sites', {
      limit: MAX_PAGE_SIZE,
      offset,
      'details-level': 'standard',
    })
    if (!res.ok) throw new Error(`show-application-sites failed: ${checkpointErrorMessage(res)}`)
    const objects = res.data?.objects ?? []
    sites.push(...objects)
    const total = res.data?.total ?? objects.length
    offset += objects.length
    if (objects.length === 0 || offset >= total) break
  }
  return sites
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Deploy Check Point custom application sites via the Management API.
 * Identity is the site `name`: list the management database
 * (show-application-sites), match on the name, and add-application-site
 * (create) / set-application-site (update) each declared site. Sites THIS
 * app created previously but no longer declares are removed
 * (delete-application-site). The whole reconciliation runs inside ONE
 * session: publish on success, discard the whole session on any error.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractApplicationSiteSpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await listAllApplicationSites(client)
    const liveByName = new Map(live.filter((s) => s.name).map((s) => [applicationSiteKey(s.name as string), s]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(applicationSiteKey(spec.name)) ?? null
      const body = buildApplicationSiteBody(spec)

      if (match) {
        const res = await client.call('set-application-site', body)
        if (!res.ok) throw new Error(`set-application-site "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const res = await client.call('add-application-site', body)
        if (!res.ok) throw new Error(`add-application-site "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => applicationSiteKey(s.name)))
    for (const p of prior) {
      if (p.existed || declaredNames.has(applicationSiteKey(p.name))) continue
      const res = await client.call('delete-application-site', { name: p.name })
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`delete-application-site "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point application site(s) on ${host}: ` +
        `${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { entries },
    }
  } catch (error) {
    await client.discard()
    await client.logout()
    return {
      success: false,
      message: `Deploy failed — session changes were discarded: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
