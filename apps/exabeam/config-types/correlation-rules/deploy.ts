import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildExabeamClient, parseJson, exabeamErrorMessage, type ExabeamClient } from '../../lib/exabeam'
import { extractRuleSpecs, parseRuleSpec, type LiveRule, type ParsedRuleSpec } from './validate'

export interface RuleRollbackEntry {
  itemId?: string
  name: string
  /** Whether this rule existed (update) or was created (create) THIS deploy. */
  existed: boolean
  /** The server-assigned rule id — the rollback/reconcile key (never the name). */
  ruleId?: string
  /** Prior rule body with server-managed read-only fields stripped, PUT back on rollback. */
  prior?: Record<string, unknown>
}

/** Server-managed fields the API returns on a rule but that must never be sent back. */
export const READONLY_RULE_FIELDS = [
  'id',
  'author',
  'lastModifier',
  'createdAt',
  'updatedAt',
  'lastTriggeredAt',
  'timesTriggered',
  'timesSuppressed',
  'autoDisabled',
] as const

/** Copy a live rule without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlyRuleFields(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rule)) {
    if (!(READONLY_RULE_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}

/** Build the create/update request body from a parsed spec. */
export function buildRuleBody(spec: ParsedRuleSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    severity: spec.severity,
    enabled: spec.enabled,
    testMode: spec.testMode,
    sequencesConfig: spec.sequencesConfig,
  }
  if (spec.description) body.description = spec.description
  if (spec.suppressConfig) body.suppressConfig = spec.suppressConfig
  if (spec.delayConfig) body.delayConfig = spec.delayConfig
  if (spec.scheduleConfig) body.scheduleConfig = spec.scheduleConfig
  return body
}

/** GET /correlation-rules/v2/rules — list every rule (no pagination documented for this endpoint). */
export async function listRules(client: ExabeamClient): Promise<{ ok: boolean; rules: LiveRule[]; status: number; body: string }> {
  const res = await client.request('GET', '/correlation-rules/v2/rules')
  if (!res.ok) return { ok: false, rules: [], status: res.status, body: res.body }
  const parsed = parseJson<LiveRule[]>(res.body)
  return { ok: true, rules: Array.isArray(parsed) ? parsed : [], status: res.status, body: res.body }
}

/** GET /correlation-rules/v2/rules/{ruleId} — fetch a single rule; null on 404. */
export async function getRuleById(client: ExabeamClient, ruleId: string): Promise<LiveRule | null> {
  const res = await client.request('GET', `/correlation-rules/v2/rules/${encodeURIComponent(ruleId)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to fetch rule ${ruleId}: ${exabeamErrorMessage(res)}`)
  return parseJson<LiveRule>(res.body)
}

async function loadPriorEntries(ctx: DeployContext): Promise<RuleRollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RuleRollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? data!.entries : []
  } catch {
    return []
  }
}

/**
 * Deploy correlation rules to Exabeam. There is no native upsert, so for each
 * declared rule:
 *   - Resolve the live rule by the ruleId stored last deploy for this canvas
 *     item (rename-safe), falling back to matching the current name.
 *   - PUT  /correlation-rules/v2/rules/{ruleId}  — update an existing rule
 *     (capture its prior body, read-only fields stripped, for rollback)
 *   - POST /correlation-rules/v2/rules           — create a missing rule
 *     (capture the new id)
 * Rules this app created on a prior deploy but no longer declares are then
 * deleted (guarded by BOTH item id and name, so a renamed-but-still-declared
 * rule — already updated above — is never deleted out from under itself).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildExabeamClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, region } = built

  const rawSpecs = extractRuleSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)

  const listed = await listRules(client)
  if (!listed.ok) {
    return { success: false, message: `Could not list Exabeam correlation rules: ${exabeamErrorMessage({ status: listed.status, ok: false, body: listed.body })}` }
  }
  const byId = new Map(listed.rules.filter((r) => r.id).map((r) => [r.id as string, r]))
  const byName = new Map(listed.rules.filter((r) => r.name).map((r) => [r.name as string, r]))
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: RuleRollbackEntry[] = []
  const deployed: string[] = []
  const failures: string[] = []

  for (const spec of rawSpecs) {
    const parseErrors: Array<{ field: string; message: string; code: string }> = []
    const parsed = parseRuleSpec(spec, spec.name, parseErrors)
    if (!parsed || parseErrors.length > 0) {
      failures.push(`${spec.name}: ${parseErrors.map((e) => e.message).join('; ') || 'invalid configuration'}`)
      continue
    }

    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live = (priorEntry?.ruleId ? byId.get(priorEntry.ruleId) : undefined) ?? byName.get(spec.name)

    try {
      if (live?.id) {
        const res = await client.request('PUT', `/correlation-rules/v2/rules/${encodeURIComponent(live.id)}`, {
          body: buildRuleBody(parsed),
        })
        if (!res.ok) throw new Error(exabeamErrorMessage(res))
        entries.push({
          itemId: spec.itemId,
          name: spec.name,
          existed: true,
          ruleId: live.id,
          prior: stripReadOnlyRuleFields(live as Record<string, unknown>),
        })
      } else {
        const res = await client.request('POST', '/correlation-rules/v2/rules', { body: buildRuleBody(parsed) })
        if (!res.ok) throw new Error(exabeamErrorMessage(res))
        const created = parseJson<LiveRule>(res.body)
        if (!created?.id) throw new Error('rule was created but the API returned no id')
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, ruleId: created.id })
      }
      deployed.push(spec.name)
    } catch (error) {
      failures.push(`${spec.name}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Reconcile: delete rules THIS app created previously but no longer declares.
  const declaredNames = new Set(rawSpecs.map((s) => s.name.toLowerCase()))
  const declaredItems = new Set(rawSpecs.map((s) => s.itemId).filter(Boolean))
  let removed = 0
  for (const p of prior) {
    if (p.existed || !p.ruleId) continue
    if ((p.itemId && declaredItems.has(p.itemId)) || declaredNames.has(p.name.toLowerCase())) continue
    const del = await client.request('DELETE', `/correlation-rules/v2/rules/${encodeURIComponent(p.ruleId)}`)
    if (!del.ok && del.status !== 404) {
      failures.push(`delete ${p.name}: ${exabeamErrorMessage(del)}`)
      continue
    }
    removed++
  }

  const summary = `Deployed ${deployed.length} correlation rule(s) to Exabeam (region ${region})${removed ? `, removed ${removed} no-longer-declared rule(s)` : ''}: ${deployed.join(', ')}`

  if (failures.length) {
    return {
      success: false,
      message: `Some correlation rules failed: ${failures.join('; ')}`,
      artifacts: { region, deployedRules: deployed },
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: summary,
    artifacts: { region, deployedRules: deployed },
    rollbackData: { entries },
  }
}
