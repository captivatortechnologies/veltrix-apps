import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, coerceBoolean, falconFailure, parseEnvelope, sameSet } from '../../lib/falcon'
import type { FalconClient, FalconResponse } from '../../lib/falcon'
import {
  createFileVantage,
  findFileVantageByName,
  updateFileVantage,
  type FileVantageEndpoints,
} from '../../lib/filevantageAdapter'
import {
  contentFieldForType,
  extractRuleGroupSpecs,
  parseRuleSpecs,
  watchAttributesForType,
  type LiveRule,
  type LiveRuleGroup,
  type RuleSpec,
} from './validate'

/** FileVantage rule-GROUP transport (shared adapter is group-shaped). */
export const RULE_GROUP_ENDPOINTS: FileVantageEndpoints = {
  entity: '/filevantage/entities/rule-groups/v1',
  queries: '/filevantage/queries/rule-groups/v1',
}

/**
 * The RULES endpoint is a distinct FileVantage path (rule-groups-rules), NOT
 * /filevantage/entities/rules/v1 — verified against FalconPy's `filevantage`
 * _endpoint table. Every rule read/write carries its parent rule_group_id.
 */
export const RULES_ENDPOINT = '/filevantage/entities/rule-groups-rules/v1'

export interface RuleGroupRollbackEntry {
  name: string
  type: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
  }
  /** ids of rules THIS deploy created under an EXISTING group (rollback deletes them). */
  createdRuleIds: string[]
}

/**
 * Deploy FileVantage rule groups to a Falcon tenant via the FileVantage API.
 *
 * A rule group is a typed collection (createRuleGroups: name, description, type;
 * type is immutable). Its rules live on the separate rule-groups-rules endpoint
 * and each carries the parent rule_group_id. For each declared group:
 *   - GET  /filevantage/queries+entities/rule-groups/v1  — find + capture prior state
 *   - POST /filevantage/entities/rule-groups/v1          — create missing group
 *   - POST /filevantage/entities/rule-groups-rules/v1    — create each declared rule missing under the group (matched by path)
 *   - PATCH /filevantage/entities/rule-groups-rules/v1   — converge declared rules whose live state differs
 *   - PATCH /filevantage/entities/rule-groups/v1         — converge the group's name/description
 *
 * Rule reconciliation: declared rules are upserted (create-or-update, matched by
 * path within the group). Rules that exist on the group but are NOT declared
 * here are LEFT UNTOUCHED — this app never deletes rules it did not declare.
 *
 * Rollback capture: a created group is deleted whole (removing its rules); an
 * existing group is patched back to its prior name/description and the rules
 * THIS deploy created are removed. Existing rules a deploy updated are not
 * field-by-field restored (documented Phase 1 limitation, matching custom-ioa).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRuleGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RuleGroupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { rules, errors: ruleErrors } = parseRuleSpecs(spec.rulesRaw)
      if (ruleErrors.length > 0) {
        throw new Error(`Rule group "${spec.name}": invalid rules — ${ruleErrors[0]}`)
      }

      const existing = await getGroupByName(client, spec.name)

      if (existing?.id) {
        const entry: RuleGroupRollbackEntry = {
          name: spec.name,
          type: spec.type,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            // Capture explicit empty so rollback can clear a description this
            // deployment sets on a group that previously had none.
            description: existing.description ?? '',
          },
          createdRuleIds: [],
        }
        rollbackState.push(entry)

        const liveRules = await getRulesForGroup(client, existing)
        const liveByPath = new Map(
          liveRules
            .filter((r) => typeof r.path === 'string')
            .map((r) => [(r.path as string).toLowerCase(), r]),
        )

        for (const rule of rules) {
          const match = liveByPath.get(rule.path.toLowerCase())
          if (!match) {
            const id = await createRule(client, existing.id, spec.type, rule)
            entry.createdRuleIds.push(id)
          } else if (ruleDiffers(rule, match, spec.type)) {
            await updateRule(client, existing.id, spec.type, rule, match)
          }
        }

        // name/description are always sent so clearing description on the canvas
        // converges the live group (and drift detection agrees with deploy).
        await updateFileVantage(client, RULE_GROUP_ENDPOINTS, {
          id: existing.id,
          name: spec.name,
          description: spec.description ?? '',
        })
      } else {
        const id = await createFileVantage(client, RULE_GROUP_ENDPOINTS, {
          name: spec.name,
          type: spec.type,
          description: spec.description ?? '',
        })
        rollbackState.push({
          name: spec.name,
          type: spec.type,
          existed: false,
          id,
          createdRuleIds: [],
        })

        // A new group is created empty — add every declared rule.
        for (const rule of rules) {
          await createRule(client, id, spec.type, rule)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} FileVantage rule group(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRuleGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `FileVantage rule group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRuleGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** Find a rule group by exact name (adapter transport), typed as a rule group. */
export async function getGroupByName(
  client: FalconClient,
  name: string,
): Promise<LiveRuleGroup | null> {
  return (await findFileVantageByName(client, RULE_GROUP_ENDPOINTS, name)) as LiveRuleGroup | null
}

/**
 * Read a group's full rules. The group entity carries only ordered rule
 * references (assigned_rules: id + precedence); the rule bodies are fetched from
 * the rules endpoint by id, scoped to the parent rule_group_id.
 */
export async function getRulesForGroup(
  client: FalconClient,
  group: LiveRuleGroup,
): Promise<LiveRule[]> {
  const ids = (group.assigned_rules ?? group.rules ?? [])
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0 || !group.id) return []

  const res = await client.request('GET', rulesPath(ids, group.id))
  if (!res.ok) {
    throw new Error(`Failed to load rules for group "${group.name ?? group.id}"`)
  }
  return parseEnvelope<LiveRule>(res.body)?.resources ?? []
}

/** Build the shared rule body — always sends every managed field so deploy fully converges. */
export function buildRuleBody(spec: RuleSpec, type: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    path: spec.path,
    severity: spec.severity,
    depth: spec.depth,
    description: spec.description,
    include: spec.include ?? '*',
    exclude: spec.exclude ?? '',
    include_users: spec.includeUsers ?? '',
    exclude_users: spec.excludeUsers ?? '',
    include_processes: spec.includeProcesses ?? '',
    exclude_processes: spec.excludeProcesses ?? '',
    enable_content_capture: spec.enableContentCapture,
  }

  const content = contentFieldForType(type)
  body[content.field] =
    (content.field === 'content_files' ? spec.contentFiles : spec.contentRegistryValues) ?? []

  for (const key of watchAttributesForType(type)) {
    body[key] = spec.watchAttributes[key] ?? false
  }
  return body
}

/** Create one rule under a group. Returns the new rule id. */
export async function createRule(
  client: FalconClient,
  ruleGroupId: string,
  type: string,
  spec: RuleSpec,
): Promise<string> {
  const body = { rule_group_id: ruleGroupId, type, ...buildRuleBody(spec, type) }
  const res = await client.request('POST', RULES_ENDPOINT, { body })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create rule "${spec.path}": ${failure}`)
  }
  const id = parseEnvelope<LiveRule>(res.body)?.resources?.[0]?.id
  if (!id) {
    throw new Error(`Rule "${spec.path}" was created but the API returned no id`)
  }
  return id
}

/** Update an existing rule in place — echoes its id and precedence (order preserved). */
export async function updateRule(
  client: FalconClient,
  ruleGroupId: string,
  type: string,
  spec: RuleSpec,
  live: LiveRule,
): Promise<void> {
  const body: Record<string, unknown> = {
    id: live.id,
    rule_group_id: ruleGroupId,
    type,
    ...buildRuleBody(spec, type),
  }
  if (typeof live.precedence === 'number') body.precedence = live.precedence

  const res = await client.request('PATCH', RULES_ENDPOINT, { body })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to update rule "${spec.path}": ${failure}`)
  }
}

/** Delete one rule by id from a group. Returns the raw response so the caller handles 404. */
export async function deleteRule(
  client: FalconClient,
  ruleGroupId: string,
  ruleId: string,
): Promise<FalconResponse> {
  return client.request('DELETE', rulesPath([ruleId], ruleGroupId))
}

/** Whether a declared rule differs from its live counterpart on any managed field. */
export function ruleDiffers(spec: RuleSpec, live: LiveRule, type: string): boolean {
  if ((live.severity ?? '') !== spec.severity) return true
  if ((live.depth ?? '') !== spec.depth) return true
  if ((live.description ?? '') !== spec.description) return true
  if ((live.include ?? '*') !== (spec.include ?? '*')) return true
  if ((live.exclude ?? '') !== (spec.exclude ?? '')) return true
  if ((live.include_users ?? '') !== (spec.includeUsers ?? '')) return true
  if ((live.exclude_users ?? '') !== (spec.excludeUsers ?? '')) return true
  if ((live.include_processes ?? '') !== (spec.includeProcesses ?? '')) return true
  if ((live.exclude_processes ?? '') !== (spec.excludeProcesses ?? '')) return true
  if ((live.enable_content_capture ?? false) !== spec.enableContentCapture) return true

  const content = contentFieldForType(type)
  const specContent =
    content.field === 'content_files' ? spec.contentFiles : spec.contentRegistryValues
  const liveContent = Array.isArray(live[content.field]) ? (live[content.field] as string[]) : []
  if (!sameSet(specContent ?? [], liveContent)) return true

  for (const key of watchAttributesForType(type)) {
    if (coerceBoolean(live[key], false) !== (spec.watchAttributes[key] ?? false)) return true
  }
  return false
}

/** Build a `?ids=a&ids=b&rule_group_id=…` path (FalconClient can't repeat query keys). */
function rulesPath(ids: string[], ruleGroupId: string): string {
  const parts = ids.map((id) => `ids=${encodeURIComponent(id)}`)
  parts.push(`rule_group_id=${encodeURIComponent(ruleGroupId)}`)
  return `${RULES_ENDPOINT}?${parts.join('&')}`
}
