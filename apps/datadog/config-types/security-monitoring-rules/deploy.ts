import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import {
  buildRuleBody,
  extractRuleSpecs,
  isJsonObject,
  parseJsonArray,
  parseJsonObject,
  ruleKey,
  type DatadogRule,
  type ListRulesResponse,
} from './_shared'

/**
 * Deploy Datadog Security Monitoring Rules via
 * GET/POST/PUT /api/v2/security_monitoring/rules[/{rule_id}]:
 *   https://docs.datadoghq.com/api/latest/security-monitoring/get-a-list-of-security-monitoring-rules/
 *   https://docs.datadoghq.com/api/latest/security-monitoring/create-a-detection-rule/
 *   https://docs.datadoghq.com/api/latest/security-monitoring/update-an-existing-rule/
 *
 * Rules have no natural upsert: identity is the rule NAME (case-insensitive).
 * The tenant's live rules are listed, matched by name, and:
 *   - a match is UPDATED (PUT, full-replace — "the whole field must be
 *     included" for cases/queries/options per the docs above). The live
 *     rule's full prior state (name/message/type/isEnabled/tags/
 *     hasExtendedTitle/queries/cases/options/filters) AND its current
 *     `version` (the update's optimistic-concurrency token) are captured for
 *     rollback before the PUT is sent.
 *   - no match is CREATED (POST); the server-assigned id is recorded so
 *     rollback can delete it.
 */
export interface RuleRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  /** Full prior live rule — only set when existed === true. */
  prior?: DatadogRule
}

const PAGE_SIZE = 100
const MAX_PAGES = 50
const RULES_PATH = '/api/v2/security_monitoring/rules'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRuleSpecs(ctx.canvas).filter((s) => s.name && s.message)
  const rollbackState: RuleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listRules(client)
    const byKey = new Map(existing.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r]))

    for (const spec of specs) {
      const label = spec.name
      const key = ruleKey(spec.name)

      const queries = parseJsonArray(spec.queriesRaw)
      const cases = parseJsonArray(spec.casesRaw)
      const options = parseJsonObject(spec.optionsRaw)
      const filters = parseJsonArray(spec.filtersRaw)
      if (!queries.ok || !cases.ok || !options.ok || !filters.ok) {
        throw new Error(`Rule "${label}": queries/cases/options/filters must be valid JSON — validate this configuration before deploying`)
      }
      const parsedFields = {
        queries: queries.value ?? [],
        cases: cases.value ?? [],
        options: options.value ?? {},
        filters: filters.value ?? [],
      }

      const live = byKey.get(key)

      if (live && live.id) {
        const prior = await readRule(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior })

        const body = buildRuleBody(spec, parsedFields, prior.version)
        const res = await client.request('PUT', `${RULES_PATH}/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to update rule "${label}": ${datadogErrorMessage(res)}`)
      } else {
        const body = buildRuleBody(spec, parsedFields)
        const res = await client.request('POST', RULES_PATH, { body })
        if (!res.ok) throw new Error(`Failed to create rule "${label}": ${datadogErrorMessage(res)}`)
        const created = parseJson<DatadogRule>(res.body)
        const id = created?.id
        if (!id) throw new Error(`Rule "${label}" was created but Datadog returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Security Monitoring Rule(s) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Security Monitoring Rule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRules: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

/**
 * List every Security Monitoring Rule, paging via `page[size]` / `page[number]`
 * (max page size 100, per the API reference). The list envelope is
 * `{ "data": [...] }` — the single-rule get/create/update responses are NOT
 * wrapped (see the citation in _shared.ts).
 */
export async function listRules(client: DatadogClient): Promise<DatadogRule[]> {
  const all: DatadogRule[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.request('GET', RULES_PATH, {
      query: { 'page[size]': PAGE_SIZE, 'page[number]': page },
    })
    if (!res.ok) throw new Error(`Failed to list Security Monitoring Rules: ${datadogErrorMessage(res)}`)
    const parsed = parseJson<ListRulesResponse>(res.body)
    const batch = Array.isArray(parsed?.data) ? (parsed?.data as DatadogRule[]) : []
    if (batch.length === 0) break
    all.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return all
}

/** Read one rule's full, authoritative state (including its current `version`). Throws on error. */
export async function readRule(client: DatadogClient, id: string): Promise<DatadogRule> {
  const res = await client.request('GET', `${RULES_PATH}/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`Failed to read rule ${id}: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<DatadogRule | { data: DatadogRule }>(res.body)
  // Defensive unwrap in case a future API revision wraps the single-rule
  // response in a {"data": {...}} envelope — the current API does not.
  const rule =
    parsed && !('id' in parsed) && isJsonObject(parsed) && isJsonObject((parsed as { data?: unknown }).data)
      ? ((parsed as { data: DatadogRule }).data as DatadogRule)
      : (parsed as DatadogRule | null)
  if (!rule) throw new Error(`Rule ${id} was not found`)
  return rule
}
