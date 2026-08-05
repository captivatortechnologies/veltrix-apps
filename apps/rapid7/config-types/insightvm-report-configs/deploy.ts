import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import {
  extractReportConfigSpecs,
  parseJsonObject,
  reportConfigKey,
  type LiveReportConfig,
  type ReportConfigSpec,
} from './validate'

export interface ReportConfigRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: number
  /** The full prior report document, captured for an update (PUT full-replace). */
  prior?: LiveReportConfig
}

/**
 * Deploy Rapid7 InsightVM report configurations via the Console API.
 *
 * Identity is the report name: list /reports, match on the name, then PUT an
 * existing report by id (full replace) or POST a new one. The scope (sites,
 * asset groups, tags) is declared by name and resolved to ids up front — an
 * unknown name fails the deploy before any write happens. This manages the
 * report's CONFIGURATION only (name, template, format, scope, schedule); it
 * never triggers generation (POST /reports/{id}/generate) or reads report
 * output (GET /reports/{id}/history/*), which are one-shot runtime actions.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractReportConfigSpecs(ctx.canvas).filter((s) => s.name && s.templateId && s.format)
  const rollbackState: ReportConfigRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const nameLookups = new ScopeNameResolver(client)

    const existing = await listReportConfigs(client)
    const byKey = new Map(
      existing.filter((r) => r.name).map((r) => [reportConfigKey({ name: r.name as string }), r]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = reportConfigKey(spec)
      const scope = await nameLookups.resolveScope(spec)
      const live = byKey.get(key)

      if (live && live.id != null) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/reports/${live.id}`, { body: buildBody(spec, scope) })
        if (!res.ok) throw new Error(`Failed to update report "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/reports', { body: buildBody(spec, scope) })
        if (!res.ok) throw new Error(`Failed to create report "${label}": ${insightVMErrorMessage(res)}`)
        const created = parseJson<{ id?: number }>(res.body)
        if (created?.id == null) throw new Error(`Report "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} report configuration(s) to ${consoleUrl}: ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedReports: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Report configuration deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedReports: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all report configurations; throws on a non-OK response. */
export async function listReportConfigs(client: InsightVMClient): Promise<LiveReportConfig[]> {
  const res = await client.getAll<LiveReportConfig>('/reports')
  if (!res.ok) {
    throw new Error(`Failed to list reports: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

export interface ResolvedScope {
  sites?: number[]
  assetGroups?: number[]
  tags?: number[]
}

/**
 * Resolves site / asset group / tag names to ids, caching each collection the
 * first time it is needed so a canvas with many report items only lists each
 * collection once.
 */
export class ScopeNameResolver {
  private sitesByName?: Map<string, number>
  private assetGroupsByName?: Map<string, number>
  private tagsByName?: Map<string, number[]>

  constructor(private readonly client: InsightVMClient) {}

  async resolveScope(spec: ReportConfigSpec): Promise<ResolvedScope> {
    const scope: ResolvedScope = {}
    if (spec.siteNames.length > 0) {
      const byName = await this.getSitesByName()
      scope.sites = spec.siteNames.map((name) => {
        const id = byName.get(name.toLowerCase())
        if (id == null) throw new Error(`Site "${name}" (referenced by report "${spec.name}") was not found on the console`)
        return id
      })
    }
    if (spec.assetGroupNames.length > 0) {
      const byName = await this.getAssetGroupsByName()
      scope.assetGroups = spec.assetGroupNames.map((name) => {
        const id = byName.get(name.toLowerCase())
        if (id == null) throw new Error(`Asset group "${name}" (referenced by report "${spec.name}") was not found on the console`)
        return id
      })
    }
    if (spec.tagNames.length > 0) {
      const byName = await this.getTagsByName()
      const ids: number[] = []
      for (const name of spec.tagNames) {
        const matches = byName.get(name.toLowerCase())
        if (!matches || matches.length === 0) {
          throw new Error(`Tag "${name}" (referenced by report "${spec.name}") was not found on the console`)
        }
        ids.push(...matches)
      }
      scope.tags = ids
    }
    return scope
  }

  private async getSitesByName(): Promise<Map<string, number>> {
    if (this.sitesByName) return this.sitesByName
    const res = await this.client.getAll<{ id?: number; name?: string }>('/sites')
    if (!res.ok) throw new Error(`Failed to list sites: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
    const byName = new Map<string, number>()
    for (const site of res.items) {
      if (site.name && site.id != null) byName.set(site.name.toLowerCase(), site.id)
    }
    this.sitesByName = byName
    return byName
  }

  private async getAssetGroupsByName(): Promise<Map<string, number>> {
    if (this.assetGroupsByName) return this.assetGroupsByName
    const res = await this.client.getAll<{ id?: number; name?: string }>('/asset_groups')
    if (!res.ok) throw new Error(`Failed to list asset groups: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
    const byName = new Map<string, number>()
    for (const group of res.items) {
      if (group.name && group.id != null) byName.set(group.name.toLowerCase(), group.id)
    }
    this.assetGroupsByName = byName
    return byName
  }

  /** Tags are keyed by name only here (unlike the (name, type) identity used for tag management), so a shared name maps to every matching tag id. */
  private async getTagsByName(): Promise<Map<string, number[]>> {
    if (this.tagsByName) return this.tagsByName
    const res = await this.client.getAll<{ id?: number; name?: string }>('/tags')
    if (!res.ok) throw new Error(`Failed to list tags: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
    const byName = new Map<string, number[]>()
    for (const tag of res.items) {
      if (!tag.name || tag.id == null) continue
      const key = tag.name.toLowerCase()
      const bucket = byName.get(key)
      if (bucket) bucket.push(tag.id)
      else byName.set(key, [tag.id])
    }
    this.tagsByName = byName
    return byName
  }
}

/**
 * Build the /reports request body. The user-settable name, template and format
 * sit at the top level alongside the resolved scope; the extra report_config_json
 * (frequency, email, storage, baseline, filters, …) is spread on top so the full
 * document can be supplied verbatim.
 */
function buildBody(spec: ReportConfigSpec, scope: ResolvedScope): Record<string, unknown> {
  const extra = parseJsonObject(spec.reportConfigJson).value ?? {}
  const body: Record<string, unknown> = { name: spec.name, format: spec.format, template: spec.templateId, ...extra }
  if (scope.sites || scope.assetGroups || scope.tags) {
    body.scope = {
      ...(scope.sites ? { sites: scope.sites } : {}),
      ...(scope.assetGroups ? { assetGroups: scope.assetGroups } : {}),
      ...(scope.tags ? { tags: scope.tags } : {}),
    }
  }
  return body
}
