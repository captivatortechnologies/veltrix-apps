import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconResponse,
  type FalconClient,
} from '../../lib/falcon'
import {
  extractRuleGroupSpecs,
  parseRuleSpecs,
  type LiveRule,
  type LiveRuleGroup,
  type RuleGroupSpec,
  type RuleSpec,
} from './validate'

export interface RuleGroupRollbackEntry {
  name: string
  platform: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    comment?: string
    version?: number
  }
  /** instance_ids of rules THIS deploy created under an existing group. */
  createdRuleInstanceIds: string[]
}

/** Fields of a single rule update inside a PATCH /ioarules/entities/rules/v1 body. */
export interface RuleUpdate {
  instance_id: string
  name: string
  description: string
  disposition_id: number
  pattern_severity: string
  field_values: unknown[]
  enabled: boolean
}

const DEPLOY_COMMENT = 'Managed by Veltrix (crowdstrike-edr app)'

/**
 * Deploy custom IOA rule groups to a Falcon tenant via the Custom IOA API.
 *
 * The rule group is on the /ioarules/ service, not the /policy/entities/*
 * family, so this writes its own find/CRUD rather than using the policy
 * adapter. For each declared rule group:
 *   - GET   /ioarules/combined/rule-groups/v1?filter=platform:'…'+name:~'…'  — find + capture prior state
 *   - POST  /ioarules/entities/rule-groups/v1   — create missing (new groups start disabled)
 *   - POST  /ioarules/entities/rules/v1         — create each declared rule missing under the group
 *   - PATCH /ioarules/entities/rules/v1         — converge declared rules (fields + enablement)
 *   - PATCH /ioarules/entities/rule-groups/v1   — converge the group's name/description/comment/enablement
 *
 * Rule reconciliation: declared rules are upserted (create-or-update, matched
 * by name within the group). Rules that exist on the group but are NOT declared
 * here are left untouched — this app never deletes rules it did not declare.
 *
 * Optimistic concurrency: rule-group and rule PATCHes must echo the group's
 * current `version` as `rulegroup_version`; every write that touches the group
 * bumps it, so the group is re-read before each version-bearing PATCH.
 *
 * Rollback capture: a created group is deleted whole (removing its rules); an
 * existing group is patched back to its prior name/description/enabled/comment
 * and the rules THIS deploy created are removed. Existing rules a deploy updated
 * are not field-by-field restored (documented Phase 1 limitation).
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

      const existing = await findRuleGroup(client, spec.name, spec.platform)

      if (existing?.id) {
        const entry: RuleGroupRollbackEntry = {
          name: spec.name,
          platform: spec.platform,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            // Capture explicit empty so rollback can clear a description this
            // deployment sets on a group that previously had none.
            description: existing.description ?? '',
            enabled: existing.enabled,
            comment: existing.comment,
            version: existing.version,
          },
          createdRuleInstanceIds: [],
        }
        rollbackState.push(entry)

        // Create any declared rule missing from the group first so enabling the
        // group later never leaves a declared rule absent.
        for (const rule of rules) {
          const match = (existing.rules ?? []).find((r) => r.name === rule.name)
          if (!match) {
            const created = await createRule(client, existing.id, rule)
            if (created.instance_id) entry.createdRuleInstanceIds.push(created.instance_id)
          }
        }

        let current = (await getRuleGroupById(client, existing.id)) ?? existing
        current = await convergeRules(client, existing.id, rules, current)

        // description/comment are always sent so clearing them on the canvas
        // converges the live group (and drift detection agrees with deploy).
        // All fields are required on a rule-group PATCH.
        await patchRuleGroup(client, {
          id: existing.id,
          name: spec.name,
          description: spec.description ?? '',
          enabled: spec.enabled,
          comment: spec.comment ?? DEPLOY_COMMENT,
          rulegroup_version: current.version ?? existing.version ?? 0,
        })
      } else {
        const created = await createRuleGroup(client, spec)
        rollbackState.push({
          name: spec.name,
          platform: spec.platform,
          existed: false,
          id: created.id,
          createdRuleInstanceIds: [],
        })
        if (!created.id) {
          throw new Error(`Rule group "${spec.name}" was created but the API returned no group id`)
        }

        // New groups are created empty and disabled — add every declared rule.
        for (const rule of rules) {
          await createRule(client, created.id, rule)
        }

        let current = (await getRuleGroupById(client, created.id)) ?? created
        current = await convergeRules(client, created.id, rules, current)

        // Enable (and set description/comment) only when needed — create already
        // set name/platform/description/comment on a disabled group.
        if (spec.enabled) {
          await patchRuleGroup(client, {
            id: created.id,
            name: spec.name,
            description: spec.description ?? '',
            enabled: true,
            comment: spec.comment ?? DEPLOY_COMMENT,
            rulegroup_version: current.version ?? 0,
          })
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} IOA rule group(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRuleGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `IOA rule group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRuleGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Converge the declared rules' fields and enablement in a single PATCH. Reads
 * the group's current rules to map each declared name to its instance_id and
 * only sends rules that differ, then re-reads the group so the caller has the
 * bumped version for the subsequent group PATCH.
 */
async function convergeRules(
  client: FalconClient,
  groupId: string,
  rules: RuleSpec[],
  current: LiveRuleGroup,
): Promise<LiveRuleGroup> {
  if (rules.length === 0) return current
  const updates = buildRuleUpdates(rules, current.rules ?? [])
  if (updates.length === 0) return current

  await updateRules(client, groupId, current.version ?? 0, updates)
  return (await getRuleGroupById(client, groupId)) ?? current
}

/**
 * Look up a rule group by exact name and platform. Exact-match name filters
 * silently return empty for most custom names, so this uses the documented
 * contains match (name:~'…') and pins the exact name client-side, paging
 * through all matches so the pin never misses a group beyond the first page.
 */
export async function findRuleGroup(
  client: FalconClient,
  name: string,
  platform: string,
): Promise<LiveRuleGroup | null> {
  const limit = 500
  const caseInsensitive: LiveRuleGroup[] = []

  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', '/ioarules/combined/rule-groups/v1', {
      query: {
        filter: `platform:'${fqlEscape(platform)}'+name:~'${fqlEscape(name)}'`,
        limit,
        offset,
      },
    })
    if (!res.ok) {
      throw new Error(`Failed to search rule group "${name}": ${falconErrorMessage(res)}`)
    }
    const groups = parseEnvelope<LiveRuleGroup>(res.body)?.resources ?? []

    const exact = groups.find((g) => g.name === name)
    if (exact) return exact
    caseInsensitive.push(...groups.filter((g) => g.name?.toLowerCase() === name.toLowerCase()))

    if (groups.length < limit) break
  }

  // Tolerate a casing difference only when it is unambiguous.
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

/** Read a single rule group (with its current version and rules) by id. */
export async function getRuleGroupById(
  client: FalconClient,
  id: string,
): Promise<LiveRuleGroup | null> {
  const res = await client.request('GET', '/ioarules/entities/rule-groups/v1', {
    query: { ids: id },
  })
  if (!res.ok) {
    throw new Error(`Failed to read rule group ${id}: ${falconErrorMessage(res)}`)
  }
  return parseEnvelope<LiveRuleGroup>(res.body)?.resources?.[0] ?? null
}

/** Create a rule group (always disabled — the API has no enabled flag on create). */
async function createRuleGroup(client: FalconClient, spec: RuleGroupSpec): Promise<LiveRuleGroup> {
  const body: Record<string, unknown> = {
    name: spec.name,
    platform: spec.platform,
    comment: spec.comment ?? DEPLOY_COMMENT,
  }
  if (spec.description !== undefined) body.description = spec.description

  const res = await client.request('POST', '/ioarules/entities/rule-groups/v1', { body })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create rule group "${spec.name}": ${failure}`)
  }
  const created = parseEnvelope<LiveRuleGroup>(res.body)?.resources?.[0]
  if (!created) {
    throw new Error(`Rule group "${spec.name}" was created but the API returned no resource`)
  }
  return created
}

/**
 * Update a rule group. All fields (name, description, enabled, comment) plus the
 * current rulegroup_version are required by the API on any change.
 */
export async function patchRuleGroup(
  client: FalconClient,
  body: {
    id: string
    name: string
    description: string
    enabled: boolean
    comment: string
    rulegroup_version: number
  },
): Promise<LiveRuleGroup> {
  const res = await client.request('PATCH', '/ioarules/entities/rule-groups/v1', { body })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to update rule group "${body.name}": ${failure}`)
  }
  return parseEnvelope<LiveRuleGroup>(res.body)?.resources?.[0] ?? {}
}

/** Create one rule under a group (created disabled — enablement is set by convergeRules). */
async function createRule(
  client: FalconClient,
  rulegroupId: string,
  rule: RuleSpec,
): Promise<LiveRule> {
  const body: Record<string, unknown> = {
    rulegroup_id: rulegroupId,
    name: rule.name,
    ruletype_id: rule.ruletypeId,
    disposition_id: rule.dispositionId,
    pattern_severity: rule.patternSeverity,
    field_values: rule.fieldValues,
    comment: rule.comment ?? DEPLOY_COMMENT,
  }
  if (rule.description !== undefined) body.description = rule.description

  const res = await client.request('POST', '/ioarules/entities/rules/v1', { body })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create rule "${rule.name}": ${failure}`)
  }
  const created = parseEnvelope<LiveRule>(res.body)?.resources?.[0]
  if (!created?.instance_id) {
    throw new Error(`Rule "${rule.name}" was created but the API returned no instance id`)
  }
  return created
}

/** Update declared rules under a group in one call, echoing the group version. */
async function updateRules(
  client: FalconClient,
  rulegroupId: string,
  version: number,
  ruleUpdates: RuleUpdate[],
): Promise<void> {
  const res = await client.request('PATCH', '/ioarules/entities/rules/v1', {
    body: {
      rulegroup_id: rulegroupId,
      rulegroup_version: version,
      comment: DEPLOY_COMMENT,
      rule_updates: ruleUpdates,
    },
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to update rules in group ${rulegroupId}: ${failure}`)
  }
}

/** Delete a whole rule group (removes its rules). Returns the raw response so the caller handles 404. */
export async function deleteRuleGroup(
  client: FalconClient,
  id: string,
  comment: string,
): Promise<FalconResponse> {
  return client.request('DELETE', '/ioarules/entities/rule-groups/v1', {
    query: { ids: id, comment },
  })
}

/** Delete one rule (by instance_id) from a group. Returns the raw response so the caller handles 404. */
export async function deleteRule(
  client: FalconClient,
  rulegroupId: string,
  instanceId: string,
  comment: string,
): Promise<FalconResponse> {
  return client.request('DELETE', '/ioarules/entities/rules/v1', {
    query: { ids: instanceId, rule_group_id: rulegroupId, comment },
  })
}

/** Build rule_updates for declared rules whose live state differs — matched by name. */
export function buildRuleUpdates(declared: RuleSpec[], live: LiveRule[]): RuleUpdate[] {
  const byName = new Map(
    live.filter((r) => typeof r.name === 'string').map((r) => [r.name as string, r]),
  )
  const updates: RuleUpdate[] = []
  for (const rule of declared) {
    const match = byName.get(rule.name)
    if (!match?.instance_id) continue
    if (!ruleDiffers(rule, match)) continue
    updates.push({
      instance_id: match.instance_id,
      name: rule.name,
      description: rule.description ?? match.description ?? '',
      disposition_id: rule.dispositionId,
      pattern_severity: rule.patternSeverity,
      field_values: rule.fieldValues,
      enabled: rule.enabled,
    })
  }
  return updates
}

/** Whether a declared rule differs from its live counterpart on any managed field. */
export function ruleDiffers(declared: RuleSpec, live: LiveRule): boolean {
  if ((live.enabled ?? false) !== declared.enabled) return true
  if (Number(live.disposition_id) !== declared.dispositionId) return true
  if ((live.pattern_severity ?? '') !== declared.patternSeverity) return true
  if ((live.description ?? '') !== (declared.description ?? '')) return true
  return JSON.stringify(live.field_values ?? []) !== JSON.stringify(declared.fieldValues)
}
