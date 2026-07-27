import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import {
  createEntity,
  getEntities,
  updateEntity,
  type EntityEndpoints,
} from '../../lib/entityAdapter'
import {
  extractSuppressionSpecs,
  type LiveRuleSelectionFilter,
  type LiveScopeAssetFilter,
  type LiveSuppressionRule,
  type SuppressionSpec,
} from './validate'

/** Paths for the Cloud Security Suppression Rules API surface. */
export const SUPPRESSION_ENDPOINTS: EntityEndpoints = {
  entity: '/cloud-policies/entities/suppression-rules/v1',
  queries: '/cloud-policies/queries/suppression-rules/v1',
  identityField: 'name',
}

/**
 * The suppression-rules query enforces a maximum page size of 50 (the shared
 * entityAdapter defaults to 500), so this collection is searched with a
 * dedicated finder that respects that cap and then reuses the adapter's
 * getEntities to fetch and pin the exact name.
 */
const QUERY_LIMIT = 50

export const DEPLOY_COMMENT = 'Managed by Veltrix (crowdstrike-edr app)'

/** Managed fields captured for rollback. */
export interface SuppressionRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    rule_selection_type?: string
    rule_selection_filter?: LiveRuleSelectionFilter
    scope_type?: string
    scope_asset_filter?: LiveScopeAssetFilter
    suppression_reason?: string
    suppression_expiration_date?: string
    disabled?: boolean
  }
}

/**
 * Deploy suppression rules to a Falcon tenant via the Cloud Security API.
 *
 * For each declared rule:
 *   - find it by its `name` identity (query capped at 50, then get + pin)
 *   - if it exists, PATCH the managed fields (body carries its id)
 *   - otherwise POST a new rule
 *
 * Prior state is captured so rollback can revert updates and delete anything
 * this deploy created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractSuppressionSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: SuppressionRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findSuppressionRule(client, spec.name)

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            description: typeof existing.description === 'string' ? existing.description : undefined,
            rule_selection_type: existing.rule_selection_type,
            rule_selection_filter: existing.rule_selection_filter,
            scope_type: existing.scope_type,
            scope_asset_filter: existing.scope_asset_filter,
            suppression_reason: existing.suppression_reason,
            suppression_expiration_date: existing.suppression_expiration_date,
            disabled: typeof existing.disabled === 'boolean' ? existing.disabled : undefined,
          },
        })
        await updateEntity(client, SUPPRESSION_ENDPOINTS, {
          id: existing.id,
          ...buildSuppressionBody(spec),
        })
      } else {
        const id = await createEntity(client, SUPPRESSION_ENDPOINTS, buildSuppressionBody(spec))
        rollbackState.push({ name: spec.name, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} suppression rule(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedSuppressionRules: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Suppression rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedSuppressionRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Find a suppression rule by its exact `name`, respecting the collection's
 * 50-result query cap. Pages the id query, fetches the entities via the shared
 * adapter, and pins the exact name (tolerating one case-insensitive match).
 */
export async function findSuppressionRule(
  client: FalconClient,
  name: string,
): Promise<LiveSuppressionRule | null> {
  const caseInsensitive: LiveSuppressionRule[] = []
  for (let offset = 0; ; offset += QUERY_LIMIT) {
    const res = await client.request('GET', SUPPRESSION_ENDPOINTS.queries, {
      query: { filter: `name:'${fqlEscape(name)}'`, limit: QUERY_LIMIT, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to search suppression rule "${name}": ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const entities = (await getEntities(client, SUPPRESSION_ENDPOINTS, ids)) as LiveSuppressionRule[]
      const exact = entities.find((e) => e.name === name)
      if (exact) return exact
      caseInsensitive.push(
        ...entities.filter(
          (e) => typeof e.name === 'string' && e.name.toLowerCase() === name.toLowerCase(),
        ),
      )
    }
    if (ids.length < QUERY_LIMIT) break
  }
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

/** Build a rule-selection filter object with only the non-empty arrays present. */
export function buildRuleSelectionFilter(spec: SuppressionSpec): LiveRuleSelectionFilter {
  const filter: LiveRuleSelectionFilter = {}
  if (spec.ruleSeverities.length > 0) filter.rule_severities = spec.ruleSeverities
  if (spec.ruleProviders.length > 0) filter.rule_providers = spec.ruleProviders
  if (spec.ruleServices.length > 0) filter.rule_services = spec.ruleServices
  if (spec.ruleIds.length > 0) filter.rule_ids = spec.ruleIds
  return filter
}

/** Build a scope asset filter object with only the non-empty arrays present. */
export function buildScopeAssetFilter(spec: SuppressionSpec): LiveScopeAssetFilter {
  const filter: LiveScopeAssetFilter = {}
  if (spec.accountIds.length > 0) filter.account_ids = spec.accountIds
  if (spec.cloudProviders.length > 0) filter.cloud_providers = spec.cloudProviders
  if (spec.regions.length > 0) filter.regions = spec.regions
  if (spec.resourceTypes.length > 0) filter.resource_types = spec.resourceTypes
  return filter
}

/** The mutable body this app manages, as the Cloud Security API expects it. */
export function buildSuppressionBody(spec: SuppressionSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    rule_selection_type: spec.ruleSelectionType,
    rule_selection_filter: buildRuleSelectionFilter(spec),
    scope_type: spec.scopeType,
    scope_asset_filter: buildScopeAssetFilter(spec),
    suppression_comment: DEPLOY_COMMENT,
    // `disabled` is a queryable property; write support is best-effort (the
    // documented create body omits it). Sent so an intentional disable is
    // applied where the API honors it.
    disabled: !spec.enabled,
  }
  if (spec.description) body.description = spec.description
  if (spec.suppressionReason) body.suppression_reason = spec.suppressionReason
  if (spec.expiration) body.suppression_expiration_date = spec.expiration
  return body
}
