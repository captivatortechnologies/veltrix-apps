import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import { canonicalPlatform, extractFilterSpecs, filterKey, type FilterSpec } from './validate'

/** Graph beta collection for assignment filters (the IntuneClient base is /beta). */
export const FILTERS_PATH = '/deviceManagement/assignmentFilters'

const FILTER_ODATA_TYPE = '#microsoft.graph.deviceAndAppManagementAssignmentFilter'

/** A live deviceAndAppManagementAssignmentFilter (only the fields we read/write). */
export interface LiveFilter {
  id?: string
  displayName?: string
  description?: string
  platform?: string
  rule?: string
  assignmentFilterManagementType?: string
  roleScopeTags?: string[]
}

export interface FilterRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    displayName?: string
    description?: string
    platform?: string
    rule?: string
    assignmentFilterManagementType?: string
    roleScopeTags?: string[]
  }
}

/** Full create body for a filter (platform included — only settable at creation). */
export function buildFilterBody(spec: FilterSpec): Record<string, unknown> {
  return {
    '@odata.type': FILTER_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description ?? '',
    platform: canonicalPlatform(spec.platform) || spec.platform,
    rule: spec.rule,
    assignmentFilterManagementType: spec.managementType || 'devices',
    roleScopeTags: spec.roleScopeTags.length > 0 ? spec.roleScopeTags : ['0'],
  }
}

/** Update body for an existing filter — platform is immutable, so it is omitted. */
export function buildFilterUpdateBody(spec: FilterSpec): Record<string, unknown> {
  const body = buildFilterBody(spec)
  delete (body as Record<string, unknown>).platform
  return body
}

/**
 * Deploy Intune assignment filters via the Graph beta assignmentFilters API.
 *
 * Reconciliation is by filter name (Graph does not enforce a unique displayName,
 * so the name is our key): list the tenant's filters, then PATCH an existing
 * filter by id or POST a new one. A filter's platform is fixed at creation — if
 * a declared filter already exists under a DIFFERENT platform it is SKIPPED (not
 * changed in place). Non-destructive: filters not declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractFilterSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: FilterRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []
  const skipped: string[] = []

  try {
    const existing = await listAssignmentFilters(client)
    const byName = new Map(existing.filter((f) => f.displayName).map((f) => [filterKey(f.displayName as string), f]))

    for (const spec of specs) {
      const live = byName.get(filterKey(spec.name))
      const declaredPlatform = canonicalPlatform(spec.platform) || spec.platform

      if (live && live.id) {
        // Platform is immutable — never attempt to change it; skip instead.
        if (live.platform && declaredPlatform && live.platform.toLowerCase() !== declaredPlatform.toLowerCase()) {
          skipped.push(spec.name)
          continue
        }
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            displayName: live.displayName,
            description: live.description,
            platform: live.platform,
            rule: live.rule,
            assignmentFilterManagementType: live.assignmentFilterManagementType,
            roleScopeTags: Array.isArray(live.roleScopeTags) ? live.roleScopeTags : [],
          },
        })
        const res = await client.request('PATCH', `${FILTERS_PATH}/${live.id}`, { body: buildFilterUpdateBody(spec) })
        if (!res.ok) throw new Error(`Failed to update assignment filter "${spec.name}": ${graphErrorMessage(res)}`)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', FILTERS_PATH, { body: buildFilterBody(spec) })
        if (!res.ok) throw new Error(`Failed to create assignment filter "${spec.name}": ${graphErrorMessage(res)}`)
        const createdFilter = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdFilter?.id })
        created.push(spec.name)
      }
    }

    const parts = [`${created.length} created`, `${updated.length} updated`]
    if (skipped.length > 0) parts.push(`${skipped.length} skipped (platform is immutable)`)
    return {
      success: true,
      message: `Assignment filters deployed to ${graphHost}: ${parts.join(', ')}`,
      artifacts: { graphHost, created, updated, skipped },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Assignment filter deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated, skipped },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List the tenant's assignment filters (list returns the full objects); throws on a non-OK response. */
export async function listAssignmentFilters(client: IntuneClient): Promise<LiveFilter[]> {
  const res = await client.getAll<LiveFilter>(FILTERS_PATH)
  if (!res.ok) {
    throw new Error(`Failed to list assignment filters: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
