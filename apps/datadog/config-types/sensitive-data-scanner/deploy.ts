import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import {
  buildGroupBody,
  buildRuleBody,
  extractGroupSpecs,
  groupKey,
  isGroupResource,
  isRuleResource,
  parseJsonArray,
  ruleKey,
  type RawRuleJson,
  type ScannerConfigResponse,
  type ScannerGroupResource,
  type ScannerRuleResource,
} from './_shared'

/**
 * Deploy Sensitive Data Scanner groups + rules via the JSON:API relationship
 * graph documented at https://docs.datadoghq.com/api/latest/sensitive-data-scanner/:
 *   GET    /api/v2/sensitive-data-scanner/config                (whole graph)
 *   POST/PATCH/DELETE .../config/groups[/{id}]
 *   POST/PATCH/DELETE .../config/rules[/{id}]
 *
 * Identity is the GROUP name (case-insensitive); within a group, rule
 * identity is the rule name (case-insensitive). One read
 * (GET .../config) discovers the org's configuration id (needed on group
 * create) and every live group + rule (JSON:API `included`).
 *   - a matched group is UPDATED (PATCH, attributes only); a matched rule is
 *     UPDATED (PATCH, attributes only).
 *   - an unmatched group/rule is CREATED (POST); a new group's rules
 *     relationship is empty at creation (Datadog requires this — rules are
 *     created afterward under the new group's id).
 *   - a LIVE rule belonging to a group but no longer declared in that
 *     group's Rules array is DELETED (this app treats Rules as the complete,
 *     authoritative set for the group — "fully declare, fully replace").
 * Does NOT manage group/rule ORDERING (see _shared.ts).
 */
export interface RuleRollbackEntry {
  key: string
  existed: boolean
  deleted: boolean
  ruleId?: string
  prior?: ScannerRuleResource
}

export interface GroupRollbackEntry {
  key: string
  label: string
  groupExisted: boolean
  groupId: string
  priorGroup?: ScannerGroupResource
  rules: RuleRollbackEntry[]
}

const CONFIG_PATH = '/api/v2/sensitive-data-scanner/config'
const GROUPS_PATH = '/api/v2/sensitive-data-scanner/config/groups'
const RULES_PATH = '/api/v2/sensitive-data-scanner/config/rules'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: GroupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const snapshot = await readScannerConfig(client)
    const byGroupKey = new Map(
      snapshot.groups.filter((g) => g.attributes?.name).map((g) => [groupKey(g.attributes!.name as string), g]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = groupKey(spec.name)

      const rulesParsed = parseJsonArray(spec.rulesRaw)
      if (!rulesParsed.ok) {
        throw new Error(`Group "${label}": rules must be valid JSON — validate this configuration before deploying`)
      }
      const declaredRules = (rulesParsed.value ?? []) as RawRuleJson[]

      const liveGroup = byGroupKey.get(key)
      let groupId: string
      let groupExisted: boolean
      let priorGroup: ScannerGroupResource | undefined

      if (liveGroup && liveGroup.id) {
        groupId = liveGroup.id
        groupExisted = true
        priorGroup = liveGroup
        const res = await client.request('PATCH', `${GROUPS_PATH}/${encodeURIComponent(groupId)}`, {
          body: { meta: {}, data: { type: 'sensitive_data_scanner_group', id: groupId, attributes: buildGroupBody(spec) } },
        })
        if (!res.ok) throw new Error(`Failed to update group "${label}": ${datadogErrorMessage(res)}`)
      } else {
        groupExisted = false
        const res = await client.request('POST', GROUPS_PATH, {
          body: {
            meta: {},
            data: {
              type: 'sensitive_data_scanner_group',
              attributes: buildGroupBody(spec),
              relationships: {
                configuration: { data: { type: 'sensitive_data_scanner_configuration', id: snapshot.configId } },
                rules: { data: [] },
              },
            },
          },
        })
        if (!res.ok) throw new Error(`Failed to create group "${label}": ${datadogErrorMessage(res)}`)
        const created = parseJson<{ data?: ScannerGroupResource }>(res.body)
        const id = created?.data?.id
        if (!id) throw new Error(`Group "${label}" was created but Datadog returned no id`)
        groupId = id
      }

      // Reconcile this group's rules: fetch the live rules currently in it
      // (empty for a just-created group), then create/update declared rules
      // and delete any live rule no longer declared.
      const liveRuleIdsForGroup =
        (groupExisted ? liveGroup?.relationships?.rules?.data : undefined)?.map((r) => r.id).filter((id): id is string => !!id) ?? []
      const liveRulesForGroup = liveRuleIdsForGroup
        .map((id) => snapshot.rulesById.get(id))
        .filter((r): r is ScannerRuleResource => !!r)
      const liveRuleByKey = new Map(
        liveRulesForGroup.filter((r) => r.attributes?.name).map((r) => [ruleKey(r.attributes!.name as string), r]),
      )

      const ruleRollback: RuleRollbackEntry[] = []
      const declaredKeys = new Set<string>()

      for (const raw of declaredRules) {
        const ruleName = typeof raw.name === 'string' ? raw.name.trim() : ''
        if (!ruleName) continue
        const rKey = ruleKey(ruleName)
        declaredKeys.add(rKey)
        const { body, standardPatternId } = buildRuleBody(raw)
        const liveRule = liveRuleByKey.get(rKey)

        if (liveRule && liveRule.id) {
          ruleRollback.push({ key: rKey, existed: true, deleted: false, ruleId: liveRule.id, prior: liveRule })
          const res = await client.request('PATCH', `${RULES_PATH}/${encodeURIComponent(liveRule.id)}`, {
            body: { meta: {}, data: { type: 'sensitive_data_scanner_rule', id: liveRule.id, attributes: body } },
          })
          if (!res.ok) throw new Error(`Failed to update rule "${ruleName}" in group "${label}": ${datadogErrorMessage(res)}`)
        } else {
          const relationships: Record<string, unknown> = { group: { data: { type: 'sensitive_data_scanner_group', id: groupId } } }
          if (standardPatternId) {
            relationships.standard_pattern = { data: { type: 'sensitive_data_scanner_standard_pattern', id: standardPatternId } }
          }
          const res = await client.request('POST', RULES_PATH, {
            body: { meta: {}, data: { type: 'sensitive_data_scanner_rule', attributes: body, relationships } },
          })
          if (!res.ok) throw new Error(`Failed to create rule "${ruleName}" in group "${label}": ${datadogErrorMessage(res)}`)
          const created = parseJson<{ data?: ScannerRuleResource }>(res.body)
          const id = created?.data?.id
          if (!id) throw new Error(`Rule "${ruleName}" in group "${label}" was created but Datadog returned no id`)
          ruleRollback.push({ key: rKey, existed: false, deleted: false, ruleId: id })
        }
      }

      for (const [rKey, liveRule] of liveRuleByKey) {
        if (declaredKeys.has(rKey) || !liveRule.id) continue
        const res = await client.request('DELETE', `${RULES_PATH}/${encodeURIComponent(liveRule.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete rule "${liveRule.attributes?.name}" in group "${label}": ${datadogErrorMessage(res)}`)
        }
        ruleRollback.push({ key: rKey, existed: true, deleted: true, ruleId: liveRule.id, prior: liveRule })
      }

      rollbackState.push({ key, label, groupExisted, groupId, priorGroup, rules: ruleRollback })
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Scanning Group(s) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sensitive Data Scanner deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

export interface ScannerSnapshot {
  configId: string
  groups: ScannerGroupResource[]
  rulesById: Map<string, ScannerRuleResource>
}

/**
 * Read the whole scanner configuration graph: the org's configuration id
 * (needed to create a group) plus every live group and rule, side-loaded in
 * the JSON:API `included` array. Not paginated — undocumented for this
 * resource, and DLP configs are bounded by Datadog's own group/rule count
 * limits (surfaced in this same response's `meta`).
 */
export async function readScannerConfig(client: DatadogClient): Promise<ScannerSnapshot> {
  const res = await client.request('GET', CONFIG_PATH)
  if (!res.ok) throw new Error(`Failed to read Sensitive Data Scanner configuration: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<ScannerConfigResponse>(res.body)
  const configId = parsed?.data?.id
  if (!configId) throw new Error('Sensitive Data Scanner configuration has no id')
  const included = parsed?.included ?? []
  const groups = included.filter(isGroupResource)
  const rulesById = new Map<string, ScannerRuleResource>()
  for (const r of included.filter(isRuleResource)) {
    if (r.id) rulesById.set(r.id, r)
  }
  return { configId, groups, rulesById }
}
